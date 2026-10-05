/**
 * The server around the Worker's app: what it adds and what it must not
 * let through. The app's own behaviour is covered by the Worker tests and
 * by scripts/e2e.ts, which CI runs against this server too.
 */

import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server";

const ADMIN = "test-admin-secret";
const INDEX = "<!doctype html><title>clipsync</title>";

function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipsync-web-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "_headers"), "/*\n  Content-Security-Policy: default-src 'self'\n  X-Frame-Options: DENY\n");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

async function start(trustProxy = false): Promise<RunningServer> {
  return startServer({
    dataDir: mkdtempSync(join(tmpdir(), "clipsync-data-")),
    webDir: webDir(),
    port: 0,
    trustProxy,
    adminSecret: ADMIN,
    log: () => {},
  });
}

function bootstrap(base: string, headers: Record<string, string> = {}, secret = ADMIN) {
  return fetch(`${base}/api/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ adminSecret: secret, deviceName: "test", platform: "linux" }),
  });
}

/** A raw HTTP request, for headers fetch() will not send. */
function raw(base: string, path: string, headers: Record<string, string>, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Bytes in, everything the server says back until it closes. */
function rawExchange(base: string, text: string) {
  const { hostname, port } = new URL(base);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.end(text));
    let out = "";
    socket.on("data", (d) => (out += d.toString()));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}

describe("serving", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await start();
  });
  afterAll(() => server.close());

  it("answers the API", async () => {
    expect(await (await fetch(`${server.url}/api/health`)).json()).toEqual({ ok: true, service: "clipsync" });
  });

  it("serves files with the _headers rules", async () => {
    const res = await fetch(`${server.url}/assets/app.js`);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  it("serves index.html for any other page, with the CSP", async () => {
    const res = await fetch(`${server.url}/link`);
    expect(await res.text()).toBe(INDEX);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("revalidates with the ETag", async () => {
    const etag = (await fetch(`${server.url}/`)).headers.get("etag")!;
    expect((await fetch(`${server.url}/`, { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  it("never serves a file outside the web directory, or _headers", async () => {
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2f..%2fetc%2fpasswd", "/_headers"]) {
      expect(await (await fetch(`${server.url}${path}`)).text()).toBe(INDEX);
    }
  });

  it("serves the installers with this server's origin", async () => {
    const script = await (await fetch(`${server.url}/install.sh`)).text();
    expect(script).toContain(server.url);
  });

  it("refuses a body over the limit before reading it", async () => {
    const res = await raw(server.url, "/api/clips", { "content-length": String(64 * 1024 * 1024) }, "POST");
    expect(res.status).toBe(413);
  });

  it("never hands out an upgrade without a valid ticket", async () => {
    const request = (connection: string) =>
      `GET /api/sync/ws?ticket=forged HTTP/1.1\r\nHost: x\r\nConnection: ${connection}\r\nUpgrade: websocket\r\n\r\n`;
    // Not a real upgrade: the plain request path, where the header is dropped.
    const plain = await rawExchange(server.url, request("close"));
    expect(plain).toMatch(/^HTTP\/1\.1 426/);
    // A real upgrade: the ticket is checked first.
    const upgrade = await rawExchange(server.url, request("Upgrade"));
    expect(upgrade).toMatch(/^HTTP\/1\.1 401/);
    for (const response of [plain, upgrade]) expect(response.toLowerCase()).not.toContain("x-clipsync-upgrade");
  });

  it("ignores a client's own CF-Connecting-IP, so it cannot pick its rate-limit key", async () => {
    // From loopback, which is never limited: a spoofed public address must not change that.
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await bootstrap(server.url, { "cf-connecting-ip": "203.0.113.9" }, "wrong")).status);
    }
    expect(statuses.every((s) => s === 403)).toBe(true);
  });
});

describe("sync socket", () => {
  let server: RunningServer;
  let token: string;
  beforeAll(async () => {
    server = await start();
    token = ((await (await bootstrap(server.url)).json()) as { token: string }).token;
  });
  afterAll(() => server.close());

  async function ticket(): Promise<string> {
    const res = await fetch(`${server.url}/api/sync/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { ticket: string }).ticket;
  }

  const wsUrl = (t: string) => `${server.url.replace("http", "ws")}/api/sync/ws?ticket=${encodeURIComponent(t)}`;

  it("upgrades with a ticket, says ready, and answers pings", async () => {
    const ws = new WebSocket(wsUrl(await ticket()));
    const frames: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error("socket failed"));
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as { type: string };
        frames.push(frame);
        if (frame.type === "ready") ws.send(JSON.stringify({ type: "ping" }));
        if (frame.type === "pong") resolve();
      };
    });
    expect(frames[0]).toMatchObject({ type: "ready", connected: [] });
    ws.close();
  });

  it("refuses a spent ticket", async () => {
    const t = await ticket();
    const first = new WebSocket(wsUrl(t));
    await new Promise((resolve) => (first.onopen = resolve));
    first.close();
    const second = new WebSocket(wsUrl(t));
    await expect(
      new Promise((resolve, reject) => {
        second.onopen = resolve;
        second.onerror = () => reject(new Error("refused"));
      }),
    ).rejects.toThrow("refused");
  });
});

describe("behind a proxy (trustProxy)", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await start(true);
  });
  afterAll(() => server.close());

  it("takes the scheme and host from X-Forwarded-*", async () => {
    const script = await (
      await fetch(`${server.url}/install.sh`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "clip.example.org" },
      })
    ).text();
    expect(script).toContain("https://clip.example.org");
  });

  it("limits by the address the proxy saw, not one the client put first", async () => {
    // The client claims 203.0.113.1; the proxy appended the real 198.51.100.7.
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await bootstrap(server.url, { "x-forwarded-for": "203.0.113.1, 198.51.100.7" }, "wrong");
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 403)).toBe(true);
    expect(statuses[5]).toBe(429);
    // A different real address has its own budget.
    expect((await bootstrap(server.url, { "x-forwarded-for": "198.51.100.8" }, "wrong")).status).toBe(403);
  });
});

describe("a proxy nobody said to trust", () => {
  const PROXY = /a proxy on this machine is forwarding requests, but --trust-proxy is off/;

  async function startLogging(trustProxy: boolean) {
    const logged: string[] = [];
    const server = await startServer({
      dataDir: mkdtempSync(join(tmpdir(), "clipsync-data-")),
      port: 0,
      trustProxy,
      adminSecret: ADMIN,
      log: (entry) => logged.push(String(entry.msg)),
    });
    return { server, logged };
  }

  it("is pointed out once, for a forwarded request over loopback", async () => {
    const { server, logged } = await startLogging(false);
    try {
      await raw(server.url, "/api/health", {});
      expect(logged.filter((m) => PROXY.test(m))).toHaveLength(0);
      await raw(server.url, "/api/health", { "x-forwarded-for": "203.0.113.7" });
      await raw(server.url, "/api/health", { "x-forwarded-for": "203.0.113.8" });
      expect(logged.filter((m) => PROXY.test(m))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("is not mentioned when the proxy is trusted", async () => {
    const { server, logged } = await startLogging(true);
    try {
      await raw(server.url, "/api/health", { "x-forwarded-for": "203.0.113.7" });
      expect(logged.filter((m) => PROXY.test(m))).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
