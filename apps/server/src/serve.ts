/**
 * Running ClipSync's server from a command line, shared by its two entry
 * points: `node clipsync-server.mjs` (main.ts) and the standalone binary's
 * `clipsync serve` (apps/agent, decisions §40).
 *
 * The first device enrols with the admin secret: CLIPSYNC_ADMIN_SECRET if
 * set, otherwise one generated on first start and kept in <data>/admin-secret.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { WebFiles } from "./assets";
import { mailerFor } from "clipsync:worker-app";
import { tlsConnect } from "./mail";
import { startServer } from "./server";

/** Self-hosted storage is not billed per operation, so only the byte ceiling applies. */
const UNMETERED = String(Number.MAX_SAFE_INTEGER);

export interface ServeDefaults {
  /** How this server is started, for --help: "clipsync serve". */
  command: string;
  /** The web UI when --web is not given: a directory, the files a build carries, or none. */
  web: string | WebFiles | null;
}

function usage(command: string): string {
  return `Usage: ${command} [options]

Runs ClipSync's server: the API, device sync and the web UI, with every
clip kept as ciphertext in one directory.

  --data <dir>         database and files (default ./clipsync-data)
  --listen <host:port> address to bind (default 127.0.0.1:8787)
  --web <dir>          serve this built web UI instead of the built-in one
  --trust-proxy        behind Caddy, nginx or \`tailscale serve\`: take the
                       client address, scheme and host from X-Forwarded-*
  --storage <bytes>    most bytes of encrypted files to hold (default 5 GiB)

The first device enrols with the admin secret: CLIPSYNC_ADMIN_SECRET if
set, otherwise one generated into <data>/admin-secret on first start.
The web UI needs HTTPS anywhere but localhost; agents work over HTTP.

More accounts: CLIPSYNC_SIGNUP=open lets anyone sign up with an email
address, which needs CLIPSYNC_SMTP_HOST, _USER, _PASSWORD and
CLIPSYNC_MAIL_FROM (CLIPSYNC_SMTP_PORT, default 465, TLS). Without it, an
admin invite (POST /api/signup/invites with the admin secret) signs one up.`;
}

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

/**
 * Keeps Node's "SQLite is an experimental feature" warning off the console.
 * It comes on every start and asks nothing of whoever runs the server; a
 * unit file can pass --disable-warning, but the standalone binary takes no
 * Node flags. Every other warning still prints.
 */
function quietSqliteWarning(): void {
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
    for (const print of printers) print(warning);
  });
}

/** Starts the server and keeps it running until SIGINT or SIGTERM. */
export async function serve(argv: string[], defaults: ServeDefaults): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: "string", default: process.env.CLIPSYNC_DATA ?? "clipsync-data" },
      listen: { type: "string", default: process.env.CLIPSYNC_LISTEN ?? "127.0.0.1:8787" },
      web: { type: "string" },
      "trust-proxy": { type: "boolean", default: process.env.CLIPSYNC_TRUST_PROXY === "1" },
      storage: { type: "string", default: process.env.CLIPSYNC_STORAGE_BYTES },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage(defaults.command));
    return;
  }

  quietSqliteWarning();
  const dataDir = resolve(values.data);
  const { host, port } = parseListen(values.listen);
  const web = values.web ? resolve(values.web) : defaults.web;
  const { secret, source } = adminSecret(dataDir);

  const running = await startServer({
    dataDir,
    webDir: typeof web === "string" ? web : null,
    webFiles: web && typeof web === "object" ? web : null,
    host,
    port,
    trustProxy: values["trust-proxy"],
    adminSecret: secret,
    vars: {
      R2_CLASS_A_BUDGET: UNMETERED,
      R2_CLASS_B_BUDGET: UNMETERED,
      ...(values.storage ? { R2_STORAGE_BUDGET_BYTES: values.storage } : {}),
      ...(process.env.CLIPSYNC_SIGNUP ? { SIGNUP: process.env.CLIPSYNC_SIGNUP } : {}),
      ...(process.env.CLIPSYNC_SIGNUP_PLAN ? { SIGNUP_PLAN: process.env.CLIPSYNC_SIGNUP_PLAN } : {}),
    },
    mailer: mailerFor(
      {
        SMTP_HOST: process.env.CLIPSYNC_SMTP_HOST,
        SMTP_PORT: process.env.CLIPSYNC_SMTP_PORT,
        SMTP_USER: process.env.CLIPSYNC_SMTP_USER,
        SMTP_PASSWORD: process.env.CLIPSYNC_SMTP_PASSWORD,
        MAIL_FROM: process.env.CLIPSYNC_MAIL_FROM,
      },
      tlsConnect,
    ),
  });

  console.log(
    JSON.stringify({
      msg: "clipsync server listening",
      url: running.url,
      data: dataDir,
      web: typeof web === "string" ? web : web ? "built in" : "none (API only)",
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
