/**
 * Clipboard history.
 *
 * `envelope` is ciphertext the server cannot read and `contentHash` is an HMAC
 * under a key the server never holds, so dedupe works without the server ever
 * learning anything about the content.
 */

import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  DEFAULT_TTL_DAYS,
  MAX_ENVELOPE_BYTES,
  type Clip,
  type CreateClipRequest,
  type CreateClipResponse,
  type ListClipsResponse,
  type SyncEvent,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { toClip, type ClipRow } from "../db";
import { newId } from "../ids";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AppEnv = { Bindings: Env; Variables: AuthVars };

/**
 * Persist first, then fan out. A client that never receives the push can still
 * recover the clip from history; the reverse is not true.
 */
async function publish(
  c: Context<AppEnv, string>,
  userId: string,
  event: SyncEvent,
): Promise<void> {
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.SYNC.getByName(userId).broadcast(event);
      } catch (error) {
        console.error({ msg: "fanout failed", type: event.type, error });
      }
    })(),
  );
}

function event<T extends SyncEvent["type"]>(
  type: T,
  origin: string,
): { version: 1; eventId: string; origin: string; timestamp: number; type: T } {
  return {
    version: 1,
    eventId: crypto.randomUUID(),
    origin,
    timestamp: Date.now(),
    type,
  };
}

export const clipRoutes = new Hono<AppEnv>()

  .use("*", requireDevice)

  .post("/", async (c) => {
    const body = await c.req.json<CreateClipRequest>().catch(() => null);
    if (
      !body ||
      typeof body.envelope !== "string" ||
      typeof body.contentHash !== "string" ||
      !body.envelope ||
      !body.contentHash
    ) {
      throw new HTTPException(400, {
        message: "envelope and contentHash are required",
      });
    }
    if (body.envelope.length > MAX_ENVELOPE_BYTES) {
      throw new HTTPException(413, {
        message: `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      });
    }

    const { userId, deviceId } = c.var.device;
    const now = Date.now();

    // Dedupe against the newest clip only. Copying A, then B, then A again is
    // three real events; copying A twice in a row is one. Clipboard managers
    // emit the latter constantly.
    const newest = await c.env.DB.prepare(
      `SELECT id, content_hash, created_at FROM clips
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(userId)
      .first<{ id: string; content_hash: string; created_at: number }>();

    if (newest?.content_hash === body.contentHash) {
      return c.json<CreateClipResponse>({
        id: newest.id,
        createdAt: newest.created_at,
        deduped: true,
      });
    }

    const clip: Clip = {
      id: newId("clip"),
      deviceId,
      type: "text",
      envelope: body.envelope,
      contentHash: body.contentHash,
      size: Number.isFinite(body.size) ? Math.max(0, body.size | 0) : 0,
      pinned: false,
      createdAt: now,
      expiresAt: now + DEFAULT_TTL_DAYS * 86_400_000,
    };

    await c.env.DB.prepare(
      `INSERT INTO clips
         (id, user_id, device_id, type, envelope, content_hash, size, pinned, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(
        clip.id,
        userId,
        clip.deviceId,
        clip.type,
        clip.envelope,
        clip.contentHash,
        clip.size,
        clip.createdAt,
        clip.expiresAt,
      )
      .run();

    await publish(c, userId, { ...event("clip.created", deviceId), clip });

    return c.json<CreateClipResponse>({
      id: clip.id,
      createdAt: clip.createdAt,
      deduped: false,
    });
  })

  /**
   * Newest-first history page. There is no `q=` parameter: the rows are
   * ciphertext, so search happens on the client after decryption.
   */
  .get("/", async (c) => {
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const before = Number(c.req.query("before")) || null;

    const stmt = before
      ? c.env.DB.prepare(
          `SELECT * FROM clips WHERE user_id = ? AND created_at < ?
            ORDER BY created_at DESC LIMIT ?`,
        ).bind(c.var.device.userId, before, limit + 1)
      : c.env.DB.prepare(
          `SELECT * FROM clips WHERE user_id = ?
            ORDER BY created_at DESC LIMIT ?`,
        ).bind(c.var.device.userId, limit + 1);

    const { results } = await stmt.all<ClipRow>();
    const page = results.slice(0, limit);

    return c.json<ListClipsResponse>({
      clips: page.map(toClip),
      nextCursor:
        results.length > limit ? (page.at(-1)?.created_at ?? null) : null,
    });
  })

  .get("/:id", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM clips WHERE id = ? AND user_id = ?",
    )
      .bind(c.req.param("id"), c.var.device.userId)
      .first<ClipRow>();

    if (!row) throw new HTTPException(404, { message: "clip not found" });
    return c.json<Clip>(toClip(row));
  })

  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const res = await c.env.DB.prepare(
      "DELETE FROM clips WHERE id = ? AND user_id = ?",
    )
      .bind(id, c.var.device.userId)
      .run();

    if (!res.meta.changes) {
      throw new HTTPException(404, { message: "clip not found" });
    }

    await publish(c, c.var.device.userId, {
      ...event("clip.deleted", c.var.device.deviceId),
      clipId: id,
    });
    return c.json({ ok: true });
  })

  /** Pinned clips survive the expiry cron. */
  .post("/:id/pin", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ pinned?: boolean }>()
      .catch(() => ({}) as { pinned?: boolean });
    const pinned = body.pinned !== false;

    const res = await c.env.DB.prepare(
      `UPDATE clips SET pinned = ?, expires_at = ?
        WHERE id = ? AND user_id = ?`,
    )
      .bind(
        pinned ? 1 : 0,
        pinned ? null : Date.now() + DEFAULT_TTL_DAYS * 86_400_000,
        id,
        c.var.device.userId,
      )
      .run();

    if (!res.meta.changes) {
      throw new HTTPException(404, { message: "clip not found" });
    }

    await publish(c, c.var.device.userId, {
      ...event("clip.pinned", c.var.device.deviceId),
      clipId: id,
      pinned,
    });
    return c.json({ ok: true, pinned });
  });
