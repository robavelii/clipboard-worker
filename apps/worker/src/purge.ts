/** Deleting what has expired, and telling anyone who would otherwise not know. */

import type { SyncEvent } from "@clipsync/protocol";

/**
 * The origin the expiry cron's events carry. No device has this id, so every
 * device applies them.
 */
export const EXPIRY_ORIGIN = "server:expiry";

/**
 * Drop expired link requests, revoking any device an approval enrolled that
 * was never collected.
 *
 * Approval enrols the joining device straight away and parks its token until
 * the joiner claims it. A joiner that gave up leaves a device nobody holds the
 * token for -- listed, "offline" forever, and still sent the new key by every
 * re-key. Revoked in the same batch as the delete, so no device outlives the
 * only row that knew its token.
 */
export function expireLinkRequests(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE devices SET revoked_at = ?
          WHERE revoked_at IS NULL AND id IN (
            SELECT device_id FROM link_requests
             WHERE expires_at < ? AND device_id IS NOT NULL)`,
      )
      .bind(now, now),
    db.prepare("DELETE FROM link_requests WHERE expires_at < ?").bind(now),
  ];
}

export interface PurgeResult {
  clips: number;
  orphanedDevices: number;
  linkRequests: number;
  invites: number;
}

/**
 * The hourly purge. Unpinned clips die on schedule -- clipboard history is a
 * liability as much as a feature -- and each deletion is announced, so an open
 * list drops the row instead of showing it until the next reload.
 */
export async function purgeExpired(env: Env, now: number): Promise<PurgeResult> {
  const [clips, orphaned, links, invites] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM clips
        WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?
        RETURNING id, user_id`,
    ).bind(now),
    ...expireLinkRequests(env.DB, now),
    env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(now),
  ]);

  const deleted = (clips?.results ?? []) as { id: string; user_id: string }[];
  const byUser = new Map<string, string[]>();
  for (const row of deleted) {
    byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.id]);
  }
  for (const [userId, ids] of byUser) {
    const events: SyncEvent[] = ids.map((clipId) => ({
      version: 1,
      eventId: crypto.randomUUID(),
      origin: EXPIRY_ORIGIN,
      timestamp: now,
      type: "clip.deleted",
      clipId,
    }));
    try {
      await env.SYNC.getByName(userId).broadcastAll(events);
    } catch (error) {
      // The rows are gone either way; a missed event costs a stale row until
      // the next reload, not correctness.
      console.error({ msg: "expiry fanout failed", userId, error });
    }
  }

  return {
    clips: deleted.length,
    orphanedDevices: orphaned?.meta.changes ?? 0,
    linkRequests: links?.meta.changes ?? 0,
    invites: invites?.meta.changes ?? 0,
  };
}
