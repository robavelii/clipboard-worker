/**
 * `clipsync-server`: run ClipSync's server on this machine.
 *
 *   node dist/clipsync-server.mjs [--data <dir>] [--listen <host:port>]
 *                                 [--web <dir>] [--trust-proxy] [--storage <bytes>]
 *
 *   --data         where the database and files live (default ./clipsync-data)
 *   --listen       address to bind (default 127.0.0.1:8787)
 *   --web          the built web UI (default: the copy next to this script)
 *   --trust-proxy  behind Caddy, nginx or `tailscale serve`: take the client
 *                  address, scheme and host from X-Forwarded-*
 *   --storage      bytes of encrypted files to hold at most (default 5 GiB)
 *
 * The first device enrols with the admin secret: CLIPSYNC_ADMIN_SECRET if
 * set, otherwise one generated on first start and kept in <data>/admin-secret.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startServer } from "./server";

/** Self-hosted storage is not billed per operation, so only the byte ceiling applies. */
const UNMETERED = String(Number.MAX_SAFE_INTEGER);

function adminSecret(dataDir: string): { secret: string; source: string } {
  const fromEnv = process.env.CLIPSYNC_ADMIN_SECRET ?? process.env.ADMIN_SECRET;
  if (fromEnv) return { secret: fromEnv, source: "the environment" };
  const file = join(dataDir, "admin-secret");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(24).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
  }
  return { secret: readFileSync(file, "utf8").trim(), source: file };
}

function parseListen(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(value) ?? /^()()(\d+)$/.exec(value);
  if (!match) throw new Error(`--listen expects host:port, got ${value}`);
  return { host: match[1] || match[2] || "127.0.0.1", port: Number(match[3]) };
}

function defaultWebDir(): string | null {
  const here = typeof import.meta.url === "string" ? fileURLToPath(new URL("./web/", import.meta.url)) : null;
  return here && existsSync(join(here, "index.html")) ? here : null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: process.env.CLIPSYNC_DATA ?? "clipsync-data" },
      listen: { type: "string", default: process.env.CLIPSYNC_LISTEN ?? "127.0.0.1:8787" },
      web: { type: "string" },
      "trust-proxy": { type: "boolean", default: process.env.CLIPSYNC_TRUST_PROXY === "1" },
      storage: { type: "string", default: process.env.CLIPSYNC_STORAGE_BYTES },
    },
  });

  const dataDir = resolve(values.data);
  const { host, port } = parseListen(values.listen);
  const webDir = values.web ? resolve(values.web) : defaultWebDir();
  const { secret, source } = adminSecret(dataDir);

  const running = await startServer({
    dataDir,
    webDir,
    host,
    port,
    trustProxy: values["trust-proxy"],
    adminSecret: secret,
    vars: {
      R2_CLASS_A_BUDGET: UNMETERED,
      R2_CLASS_B_BUDGET: UNMETERED,
      ...(values.storage ? { R2_STORAGE_BUDGET_BYTES: values.storage } : {}),
    },
  });

  console.log(
    JSON.stringify({
      msg: "clipsync server listening",
      url: running.url,
      data: dataDir,
      web: webDir ?? "none (API only)",
      adminSecret: source,
      trustProxy: values["trust-proxy"],
    }),
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ msg: "shutting down", signal }));
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
