/// <reference path="./worker.d.ts" />

/**
 * ClipSync on Node: the Worker's own Hono app (apps/worker/src/app.ts),
 * served with Node implementations of the bindings it expects (decisions §38).
 *
 *   DB            SqliteD1         <data>/clipsync.db (node:sqlite)
 *   BLOBS         DiskBucket       <data>/blobs/
 *   SYNC          Rooms            in process, sockets on `ws`
 *   *_LIMIT       MemoryRateLimiter
 *   cron          setInterval      purgeExpired, hourly
 *   assets        StaticAssets     the built web UI, with its _headers
 *
 * Requests reach the app exactly as the Worker would see them. Paths the
 * Worker runs first (/api/*, the installers) go to the app and everything
 * else to the static files, as `run_worker_first` arranges on Cloudflare.
 * CF-Connecting-IP is set here from the connection, or with `trustProxy`
 * from the reverse proxy's X-Forwarded-For, and any copy a client sent is
 * dropped: the rate limits key on it.
 */

import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { getRequestListener, type HttpBindings, type Http2Bindings } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { app, purgeExpired, type Mailer } from "clipsync:worker-app";
import inputs from "clipsync:worker-inputs";
import { StaticAssets, type WebFiles } from "./assets";
import { DiskBucket } from "./bucket";
import { migrate, SqliteD1 } from "./d1";
import { MemoryRateLimiter } from "./limiter";
import { Rooms, UPGRADE_HANDLE_HEADER } from "./rooms";
import { installWorkersRuntime } from "./runtime";

/** The Workers platform refuses bodies past 100 MB; the largest real one is a re-encrypt batch (~13 MB). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

export interface ServerOptions {
  /** Holds clipsync.db and blobs/. Created if missing. */
  dataDir: string;
  /** The built web UI (apps/web/dist). Without it only the API is served. */
  webDir?: string | null;
  /** The web UI's files themselves, as the standalone binary carries them; wins over webDir. */
  webFiles?: WebFiles | null;
  host?: string;
  port?: number;
  /** Behind a reverse proxy: take the client address, scheme and host from X-Forwarded-*. */
  trustProxy?: boolean;
  adminSecret: string;
  /** Overrides for the Worker's vars (wrangler.jsonc), e.g. R2_STORAGE_BUDGET_BYTES. */
  vars?: Record<string, string>;
  /** How signup codes are mailed; without one, open signup answers 503. */
  mailer?: Mailer | null;
  purgeIntervalMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface RunningServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const isWorkerPath = (path: string) =>
  path.startsWith("/api/") || path === "/install.sh" || path === "/install.ps1";

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  installWorkersRuntime();
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));

  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const db = new SqliteD1(join(options.dataDir, "clipsync.db"));
  const applied = migrate(db, inputs.migrations);
  if (applied.length) log({ msg: "applied migrations", migrations: applied });

  const rooms = new Rooms();
  const limiters = Object.fromEntries(
    Object.entries(inputs.limits).map(([name, { limit, period }]) => [name, new MemoryRateLimiter(limit, period)]),
  );
  const env = {
    ...Object.fromEntries(Object.entries(inputs.vars).map(([k, v]) => [k, String(v)])),
    ...options.vars,
    ADMIN_SECRET: options.adminSecret,
    MAILER: options.mailer ?? null,
    DB: db,
    BLOBS: new DiskBucket(join(options.dataDir, "blobs")),
    SYNC: rooms,
    ...limiters,
  };

  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      const tracked = promise
        .catch((error) => log({ msg: "waitUntil task failed", error: String(error) }))
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    passThroughOnException() {},
    props: {},
  };

  const assets = options.webFiles
    ? StaticAssets.fromFiles(options.webFiles)
    : options.webDir
      ? StaticAssets.fromDirectory(options.webDir)
      : null;
  const trustProxy = options.trustProxy ?? false;

  // A proxy on this machine that nobody said to trust: every request then
  // seems to come from loopback, which the rate limits exempt, and links
  // carry the proxy's scheme. Said once, at the first forwarded request
  // over loopback. Never for one from elsewhere: any client can send the
  // header, and trusting it there would let clients claim any address.
  let warnedProxy = false;
  function noticeProxy(incoming: IncomingMessage): void {
    if (trustProxy || warnedProxy || !incoming.headers["x-forwarded-for"]) return;
    if (!isLoopback(incoming.socket.remoteAddress)) return;
    warnedProxy = true;
    log({
      msg: "a proxy on this machine is forwarding requests, but --trust-proxy is off: every client looks like 127.0.0.1, which the rate limits exempt. Pass --trust-proxy (CLIPSYNC_TRUST_PROXY=1).",
    });
  }

  async function handle(request: Request, path: string): Promise<Response> {
    if (isWorkerPath(path) || !assets || (request.method !== "GET" && request.method !== "HEAD")) {
      return app.fetch(request, env, ctx);
    }
    return assets.serve(request);
  }

  const listener = getRequestListener(
    async (raw, bindings: HttpBindings | Http2Bindings) => {
      // An HTTP/1.1 server: always an IncomingMessage.
      const incoming = bindings.incoming as IncomingMessage;
      noticeProxy(incoming);
      const declared = Number(incoming.headers["content-length"] ?? 0);
      if (declared > MAX_BODY_BYTES) return new Response("request body too large", { status: 413 });
      const request = toWorkerRequest(raw, incoming, trustProxy, { upgrade: false });
      try {
        const response = await handle(request, new URL(request.url).pathname);
        return withoutHeader(response, UPGRADE_HANDLE_HEADER);
      } catch (error) {
        log({ msg: "unhandled error", path: new URL(request.url).pathname, error: String(error) });
        return new Response("internal error", { status: 500 });
      }
    },
    { overrideGlobalObjects: false },
  );

  const server = createServer(listener);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        noticeProxy(incoming);
        const url = requestUrl(incoming, trustProxy);
        const request = new Request(url, {
          method: incoming.method ?? "GET",
          headers: workerHeaders(incoming, trustProxy, { upgrade: true }),
        });
        const response = isWorkerPath(url.pathname)
          ? await app.fetch(request, env, ctx)
          : new Response("not found", { status: 404 });
        const upgradeHandle = response.headers.get(UPGRADE_HANDLE_HEADER);
        if (response.status === 200 && upgradeHandle) {
          wss.handleUpgrade(incoming, socket, head, (ws) => {
            alive.set(ws, true);
            ws.on("pong", () => alive.set(ws, true));
            if (!rooms.accept(upgradeHandle, ws)) ws.close(1011, "upgrade expired");
          });
          return;
        }
        await writeRawResponse(socket, response);
      } catch (error) {
        log({ msg: "upgrade failed", error: String(error) });
        socket.destroy();
      }
    })();
  });

  // Protocol-level pings find connections that died without a close (a
  // laptop lid, a dropped NAT mapping), which the Workers runtime does for
  // the Durable Object. Clients answer them without involving their code.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const purge = setInterval(() => {
    purgeExpired(env, Date.now())
      .then((result) => log({ msg: "purged expired rows", ...result }))
      .catch((error) => log({ msg: "purge failed", error: String(error) }));
  }, options.purgeIntervalMs ?? HOUR_MS);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const host = options.host && options.host !== "0.0.0.0" && options.host !== "::" ? options.host : "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  return {
    url,
    server,
    async close() {
      clearInterval(heartbeat);
      clearInterval(purge);
      for (const ws of rooms.sockets()) ws.close(1001, "server shutting down");
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.allSettled([...pending]);
      for (const limiter of Object.values(limiters)) limiter.close();
      db.close();
    },
  };
}

/* ------------------------------ requests ------------------------------ */

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(",")[0]?.trim() || undefined;
}

function requestUrl(incoming: IncomingMessage, trustProxy: boolean): URL {
  const encrypted = (incoming.socket as { encrypted?: boolean }).encrypted === true;
  const proto = (trustProxy && first(incoming.headers["x-forwarded-proto"])) || (encrypted ? "https" : "http");
  const host = (trustProxy && first(incoming.headers["x-forwarded-host"])) || incoming.headers.host || "localhost";
  return new URL(incoming.url ?? "/", `${proto}://${host}`);
}

/** 127.0.0.0/8 and ::1, also as IPv4-mapped IPv6 (a dual-stack listener's form). */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) || address === "::1";
}

/**
 * The client's address. Behind a proxy, the last X-Forwarded-For entry: the
 * one the proxy in front of us added. Earlier entries are whatever the
 * client claimed.
 */
function clientAddress(incoming: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const header = incoming.headers["x-forwarded-for"];
    const entries = (Array.isArray(header) ? header.join(",") : header ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }
  return incoming.socket.remoteAddress;
}

function workerHeaders(incoming: IncomingMessage, trustProxy: boolean, { upgrade }: { upgrade: boolean }): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  headers.delete("cf-connecting-ip");
  headers.delete(UPGRADE_HANDLE_HEADER);
  // Only the `upgrade` event may reach the room's upgrade path.
  if (!upgrade) headers.delete("upgrade");
  const address = clientAddress(incoming, trustProxy);
  if (address) headers.set("cf-connecting-ip", address);
  return headers;
}

function toWorkerRequest(
  raw: Request,
  incoming: IncomingMessage,
  trustProxy: boolean,
  { upgrade }: { upgrade: boolean },
): Request {
  const hasBody = raw.method !== "GET" && raw.method !== "HEAD" && raw.body !== null;
  return new Request(requestUrl(incoming, trustProxy), {
    method: raw.method,
    headers: workerHeaders(incoming, trustProxy, { upgrade }),
    body: hasBody ? raw.body!.pipeThrough(capped(MAX_BODY_BYTES)) : null,
    signal: raw.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Fails the body stream once it passes `limit` bytes, for bodies sent without a length. */
function capped(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) controller.error(new Error("request body too large"));
      else controller.enqueue(chunk);
    },
  });
}

function withoutHeader(response: Response, name: string): Response {
  if (!response.headers.has(name)) return response;
  const headers = new Headers(response.headers);
  headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** An HTTP response written straight to a socket the server will not upgrade. */
async function writeRawResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`];
  response.headers.forEach((value, name) => {
    if (name !== "content-length" && name !== "connection") lines.push(`${name}: ${value}`);
  });
  lines.push(`content-length: ${body.byteLength}`, "connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}
