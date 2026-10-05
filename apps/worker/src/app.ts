/**
 * The ClipSync API as a Hono app, with no runtime bindings of its own.
 *
 * Everything it touches comes in through `Env` (D1, R2, the SyncRoom
 * namespace, the rate limiters, vars) and the execution context. The
 * Worker entry (index.ts) serves it on Cloudflare; apps/server serves the
 * same app on Node, with its own implementations of those bindings
 * (decisions §38). Nothing in here may import from `cloudflare:*`.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiError } from "@clipsync/protocol";
import { agentGate } from "./agent-gate";
import { accountRoutes } from "./routes/account";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { clipRoutes } from "./routes/clips";
import { deviceRoutes } from "./routes/devices";
import { installRoutes } from "./routes/install";
import { inviteRoutes } from "./routes/invites";
import { linkRoutes } from "./routes/link";
import { signinRoutes, signupRoutes } from "./routes/signup";
import { syncRoutes } from "./routes/sync";
import { vaultRoutes } from "./routes/vault";

export { purgeExpired } from "./purge";
export { mailerFor } from "./mail";

export const app = new Hono<{ Bindings: Env }>()

  .get("/api/health", (c) => c.json({ ok: true, service: "clipsync" }))
  .route("/", installRoutes)
  .use("/api/*", agentGate)

  .route("/api/auth", authRoutes)
  .route("/api/account", accountRoutes)
  .route("/api/signup", signupRoutes)
  .route("/api/signin", signinRoutes)
  .route("/api/devices", deviceRoutes)
  .route("/api/vault", vaultRoutes)
  .route("/api/link", linkRoutes)
  .route("/api/invites", inviteRoutes)
  .route("/api/clips", clipRoutes)
  .route("/api/blobs", blobRoutes)
  .route("/api/sync", syncRoutes)

  .notFound((c) =>
    c.json<ApiError>({ error: "not_found", message: "no such endpoint" }, 404),
  )

  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json<ApiError>(
        { error: httpErrorCode(err.status), message: err.message },
        err.status,
      );
    }
    // Structured so the log line is queryable in the observability tab.
    console.error({
      msg: "unhandled error",
      path: c.req.path,
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json<ApiError>(
      { error: "internal", message: "internal error" },
      500,
    );
  });

function httpErrorCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 426:
      return "upgrade_required";
    case 503:
      return "unavailable";
    default:
      return "error";
  }
}
