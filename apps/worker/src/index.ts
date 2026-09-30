/**
 * ClipSync Worker: REST API, sync WebSocket, static web UI and the expiry cron.
 *
 * The Worker is deliberately a dumb pipe for clipboard content. It sees
 * ciphertext envelopes and HMAC dedupe tags, never plaintext and never a key.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiError } from "@clipsync/protocol";
import { authRoutes } from "./routes/auth";
import { blobRoutes } from "./routes/blobs";
import { clipRoutes } from "./routes/clips";
import { deviceRoutes } from "./routes/devices";
import { installRoutes } from "./routes/install";
import { inviteRoutes } from "./routes/invites";
import { linkRoutes } from "./routes/link";
import { syncRoutes } from "./routes/sync";
import { vaultRoutes } from "./routes/vault";

import { purgeExpired } from "./purge";

export { SyncRoom } from "./sync-room";

const app = new Hono<{ Bindings: Env }>()

  .get("/api/health", (c) => c.json({ ok: true, service: "clipsync" }))
  .route("/", installRoutes)

  .route("/api/auth", authRoutes)
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

export default {
  fetch: app.fetch,

  /** Hourly purge; see purge.ts. */
  async scheduled(_controller, env, _ctx): Promise<void> {
    console.log({ msg: "purged expired rows", ...(await purgeExpired(env, Date.now())) });
  },
} satisfies ExportedHandler<Env>;
