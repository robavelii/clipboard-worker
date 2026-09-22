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
import { clipRoutes } from "./routes/clips";
import { deviceRoutes } from "./routes/devices";
import { linkRoutes } from "./routes/link";
import { syncRoutes } from "./routes/sync";
import { vaultRoutes } from "./routes/vault";

export { SyncRoom } from "./sync-room";

const app = new Hono<{ Bindings: Env }>()

  .get("/api/health", (c) => c.json({ ok: true, service: "clipsync" }))

  .route("/api/auth", authRoutes)
  .route("/api/devices", deviceRoutes)
  .route("/api/vault", vaultRoutes)
  .route("/api/link", linkRoutes)
  .route("/api/clips", clipRoutes)
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

  /**
   * Hourly purge. Clipboard history is a liability as much as a feature --
   * unpinned clips die on schedule so a stale API token in the log cannot be
   * recovered from last spring.
   */
  async scheduled(_controller, env, _ctx): Promise<void> {
    const now = Date.now();
    const purged = await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM clips WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?",
      ).bind(now),
      env.DB.prepare("DELETE FROM link_requests WHERE expires_at < ?").bind(now),
    ]);
    console.log({
      msg: "purged expired rows",
      clips: purged[0]?.meta.changes ?? 0,
      linkRequests: purged[1]?.meta.changes ?? 0,
    });
  },
} satisfies ExportedHandler<Env>;
