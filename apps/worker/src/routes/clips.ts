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
  MAX_REENCRYPT_BATCH,
  STALE_EPOCH_ERROR,
  type ApiError,
  type Clip,
  type CreateClipRequest,
  type CreateClipResponse,
  type ListClipsResponse,
  type ReencryptClipsRequest,
  type ReencryptClipsResponse,
  type SyncEvent,
} from "@clipsync/protocol";
import { peekClipHeader } from "@clipsync/crypto";
import { requireDevice, type AuthVars } from "../auth";
import { toClip, type ClipRow } from "../db";
import { newId } from "../ids";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AppEnv = { Bindings: Env; Variables: AuthVars };

/**
 * `?before=`: `<createdAt>.<id>` as nextCursor hands it out. A bare
 * timestamp, from clients that predate the id half, still pages -- with the
 * old gap at a shared millisecond: its empty id sorts before every real one,
 * so it keeps meaning "older than this timestamp".
 */
function parseCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const createdAt = Number(dot === -1 ? raw : raw.slice(0, dot));
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  return { createdAt, id: dot === -1 ? "" : raw.slice(dot + 1) };
}

/**
 * A clip envelope this device may store: legacy v1, or a v2 whose readable
 * header names this device and a text clip. The header is authenticated
 * only to clients, but checking it here keeps an honest server's rows and
 * envelopes in agreement -- which is what clients hold them to.
 */
function assertEnvelope(envelope: string, deviceId: string): void {
  if (envelope.startsWith("v1.")) return;
  const header = peekClipHeader(envelope);
  if (!header) {
    throw new HTTPException(400, { message: "envelope must be v1 or v2" });
  }
  if (header.device !== deviceId || header.type !== "text") {
    throw new HTTPException(400, {
      message: "a v2 envelope must name the device writing it and a text clip",
    });
  }
}

/** A write under a vault key the account has rotated away from. */
function staleEpoch(c: Context<AppEnv, string>, epoch: number) {
  return c.json<ApiError>(
    {
      error: STALE_EPOCH_ERROR,
      message: `the vault was re-keyed (now epoch ${epoch}) -- fetch the new key and write again`,
    },
    409,
  );
}

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
    assertEnvelope(body.envelope, deviceId);

    // Clips are only stored under the current vault key. A device that has
    // not picked up a re-key yet is sent to fetch it, rather than leaving new
    // ciphertext under a key a revoked device may still hold. Older clients
    // send no epoch: they are on 0, and stop being accepted after a re-key.
    const keyEpoch = body.keyEpoch ?? 0;
    const current = await c.env.DB.prepare(
      "SELECT key_epoch FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ key_epoch: number }>();
    if (current?.key_epoch !== keyEpoch) {
      return staleEpoch(c, current?.key_epoch ?? 0);
    }

    // Dedupe across the whole history, not just the newest clip.
    //
    // Copying something you copied last week should move that entry back to
    // the top, not add a second identical row -- which is what every clipboard
    // manager does, and what stops a deleted secret quietly reappearing every
    // time it is copied again.
    const existing = await c.env.DB.prepare(
      `SELECT * FROM clips WHERE user_id = ? AND content_hash = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(userId, body.contentHash)
      .first<ClipRow>();

    if (existing) {
      const newest = await c.env.DB.prepare(
        `SELECT id FROM clips WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(userId)
        .first<{ id: string }>();

      // Already on top: nothing to reorder, and no reason to tell anyone.
      // Clipboard managers re-announce the current selection constantly.
      if (newest?.id === existing.id) {
        return c.json<CreateClipResponse>({
          id: existing.id,
          createdAt: existing.created_at,
          deduped: true,
        });
      }

      const bumpedAt = now;
      const expiresAt = existing.pinned
        ? existing.expires_at
        : bumpedAt + DEFAULT_TTL_DAYS * 86_400_000;

      // The new envelope replaces the stored one. Same plaintext, but a v2
      // envelope vouches for who copied it and when, and a device checks
      // that against the row: the old one names the first copy.
      await c.env.DB.prepare(
        `UPDATE clips SET created_at = ?, device_id = ?, expires_at = ?, envelope = ?
          WHERE id = ? AND user_id = ?`,
      )
        .bind(bumpedAt, deviceId, expiresAt, body.envelope, existing.id, userId)
        .run();

      const bumped = toClip({
        ...existing,
        created_at: bumpedAt,
        device_id: deviceId,
        expires_at: expiresAt,
        envelope: body.envelope,
      });

      await publish(c, userId, {
        ...event("clip.bumped", deviceId),
        clip: bumped,
      });

      return c.json<CreateClipResponse>({
        id: existing.id,
        createdAt: bumpedAt,
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
      keyEpoch,
    };

    // Guarded on the epoch again, in the same statement: a re-key landing
    // between the check above and this write must not let it through.
    const inserted = await c.env.DB.prepare(
      `INSERT INTO clips
         (id, user_id, device_id, type, envelope, content_hash, size, pinned,
          created_at, expires_at, key_epoch)
       SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
        WHERE (SELECT key_epoch FROM users WHERE id = ?) = ?`,
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
        keyEpoch,
        userId,
        keyEpoch,
      )
      .run();
    if (!inserted.meta.changes) return staleEpoch(c, keyEpoch + 1);

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
   *
   * `?pinned=1` returns every pinned clip instead, unpaged. Clients list pins
   * first, and a pin older than the pages they have loaded would otherwise be
   * missing from the top of the list. Pins never expire, but they are chosen
   * one at a time, so the set stays small; MAX_LIMIT bounds it regardless.
   */
  .get("/", async (c) => {
    if (c.req.query("pinned") === "1") {
      const { results } = await c.env.DB.prepare(
        `SELECT * FROM clips WHERE user_id = ? AND pinned = 1
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(c.var.device.userId, MAX_LIMIT)
        .all<ClipRow>();
      return c.json<ListClipsResponse>({
        clips: results.map(toClip),
        nextCursor: null,
      });
    }

    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const before = parseCursor(c.req.query("before"));
    // `?epochBelow=N`: only clips still under a key older than epoch N, for
    // re-encrypting history after a re-key.
    const epochBelow = c.req.query("epochBelow");

    const where = ["user_id = ?"];
    const params: unknown[] = [c.var.device.userId];
    if (before) {
      // Strictly after the cursor in (created_at, id) order. created_at
      // alone skips a clip sharing the last one's millisecond, which a
      // re-encryption pass or a bump makes likely.
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(before.createdAt, before.createdAt, before.id);
    }
    if (epochBelow !== undefined) {
      where.push("key_epoch < ?");
      params.push(Number(epochBelow) || 0);
    }

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM clips WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...params, limit + 1)
      .all<ClipRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);

    return c.json<ListClipsResponse>({
      clips: page.map(toClip),
      nextCursor: results.length > limit && last ? `${last.created_at}.${last.id}` : null,
    });
  })

  /**
   * Move clips to the current vault key after a re-key.
   *
   * The client decrypts each with the key it was stored under and sends it
   * back encrypted under the current one, with a fresh dedupe tag. Each write
   * is conditional on the clip still being at `fromEpoch` and the account
   * still being at the epoch this request targets, so a replay, a race with
   * another device doing the same, or a second re-key all write nothing.
   */
  .post("/reencrypt", async (c) => {
    const body = await c.req
      .json<Partial<ReencryptClipsRequest>>()
      .catch(() => ({}) as Partial<ReencryptClipsRequest>);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_REENCRYPT_BATCH) {
      throw new HTTPException(400, {
        message: `items must hold 1 to ${MAX_REENCRYPT_BATCH} clips`,
      });
    }
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !Number.isInteger(item.fromEpoch) ||
        typeof item.envelope !== "string" ||
        peekClipHeader(item.envelope)?.type !== "text" ||
        item.envelope.length > MAX_ENVELOPE_BYTES ||
        typeof item.contentHash !== "string" ||
        !item.contentHash
      ) {
        throw new HTTPException(400, {
          message: "each item needs id, fromEpoch, a v2 envelope and contentHash",
        });
      }
    }

    const userId = c.var.device.userId;
    const current = await c.env.DB.prepare(
      "SELECT key_epoch FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ key_epoch: number }>();
    const epoch = current?.key_epoch ?? 0;

    const results = await c.env.DB.batch(
      items.map((item) =>
        c.env.DB.prepare(
          // The envelope must name the device the row does: re-encryption
          // moves a clip to a new key, it does not re-attribute it.
          `UPDATE clips SET envelope = ?, content_hash = ?, key_epoch = ?
            WHERE id = ? AND user_id = ? AND key_epoch = ? AND key_epoch < ?
              AND device_id = ?
              AND (SELECT key_epoch FROM users WHERE id = ?) = ?`,
        ).bind(
          item.envelope,
          item.contentHash,
          epoch,
          item.id,
          userId,
          item.fromEpoch,
          epoch,
          peekClipHeader(item.envelope)!.device,
          userId,
          epoch,
        ),
      ),
    );

    return c.json<ReencryptClipsResponse>({
      updated: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0),
      epoch,
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
