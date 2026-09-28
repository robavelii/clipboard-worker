/**
 * Every R2 operation this Worker makes, kept inside a budget under
 * Cloudflare's free tier.
 *
 * R2 has no spending cap of its own: past the free tier it bills. The bucket
 * has no public access, so this Worker is the only thing that touches it,
 * and counting here counts everything that costs money:
 *
 *   - Class A (writes: PutObject)  counted per UTC month, refused past budget
 *   - Class B (reads: GetObject)   counted per UTC month, refused past budget
 *   - storage                      a ceiling on bytes held; the oldest
 *                                  unpinned files are deleted to make room
 *   - deletes                      free, never refused
 *
 * The budgets are Worker vars (wrangler.jsonc), half the free tier by default.
 */

import type { SyncEvent } from "@clipsync/protocol";

/** Where chunk `idx` of blob `id` lives in the bucket. */
export function chunkKey(id: string, idx: number): string {
  return `blobs/${id}/${idx}`;
}

function monthOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Count `n` operations of a class against this month's budget, before making
 * them. False when that would exceed the budget: the caller refuses the
 * request and nothing is spent. The conditional UPDATE is the check, so two
 * racing requests cannot both take the last unit.
 */
export async function spend(env: Env, cls: "a" | "b", n = 1, now = Date.now()): Promise<boolean> {
  const month = monthOf(now);
  const column = cls === "a" ? "class_a" : "class_b";
  const budget = Number(cls === "a" ? env.R2_CLASS_A_BUDGET : env.R2_CLASS_B_BUDGET);
  const [, spent] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO r2_usage (month) VALUES (?)").bind(month),
    env.DB.prepare(
      `UPDATE r2_usage SET ${column} = ${column} + ?1
        WHERE month = ?2 AND ${column} + ?1 <= ?3`,
    ).bind(n, month, budget),
  ]);
  return (spent?.meta.changes ?? 0) > 0;
}

export async function usage(env: Env, now = Date.now()) {
  const month = monthOf(now);
  const [ops, stored] = await env.DB.batch([
    env.DB.prepare("SELECT class_a, class_b FROM r2_usage WHERE month = ?").bind(month),
    env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs"),
  ]);
  const row = (ops?.results[0] ?? {}) as { class_a?: number; class_b?: number };
  return {
    month,
    storedBytes: ((stored?.results[0] ?? {}) as { bytes?: number }).bytes ?? 0,
    storageBudgetBytes: Number(env.R2_STORAGE_BUDGET_BYTES),
    classA: row.class_a ?? 0,
    classABudget: Number(env.R2_CLASS_A_BUDGET),
    classB: row.class_b ?? 0,
    classBBudget: Number(env.R2_CLASS_B_BUDGET),
  };
}

/**
 * Delete blobs: their objects in R2 (free, and never refused), then their
 * rows. Objects first, so a failure leaves a row pointing at nothing rather
 * than an object nothing points at.
 */
export async function deleteBlobs(env: Env, ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  const placeholders = unique.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, chunks FROM blobs WHERE id IN (${placeholders})`,
  )
    .bind(...unique)
    .all<{ id: string; chunks: number }>();
  const keys = results.flatMap((b) =>
    Array.from({ length: b.chunks }, (_, i) => chunkKey(b.id, i)),
  );
  for (let i = 0; i < keys.length; i += 1000) {
    await env.BLOBS.delete(keys.slice(i, i + 1000));
  }
  await env.DB.prepare(`DELETE FROM blobs WHERE id IN (${placeholders})`)
    .bind(...unique)
    .run();
}

function deletedEvent(clipId: string, now: number): SyncEvent {
  return {
    version: 1,
    eventId: crypto.randomUUID(),
    origin: "server:storage",
    timestamp: now,
    type: "clip.deleted",
    clipId,
  };
}

/**
 * Reserve `bytes` of storage for a new blob, deleting the oldest unpinned
 * image and file clips while it does not fit. Returns the new blob's id, or
 * null when pinned files alone leave no room.
 *
 * The insert is conditional on the total, so concurrent uploads cannot
 * together overshoot the ceiling; a loser evicts again and retries.
 */
export async function reserveBlob(
  env: Env,
  userId: string,
  id: string,
  chunks: number,
  bytes: number,
  now = Date.now(),
): Promise<boolean> {
  const budget = Number(env.R2_STORAGE_BUDGET_BYTES);
  if (bytes > budget) return false;

  for (let attempt = 0; attempt < 20; attempt++) {
    const inserted = await env.DB.prepare(
      `INSERT INTO blobs (id, user_id, chunks, size, created_at)
       SELECT ?, ?, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(size), 0) FROM blobs) + ? <= ?`,
    )
      .bind(id, userId, chunks, bytes, now, bytes, budget)
      .run();
    if (inserted.meta.changes) return true;

    // Oldest first: the files least likely to still be wanted.
    const { results: victims } = await env.DB.prepare(
      `SELECT c.id, c.user_id, c.blob_id FROM clips c
        WHERE c.blob_id IS NOT NULL AND c.pinned = 0
        ORDER BY c.created_at ASC LIMIT 10`,
    ).all<{ id: string; user_id: string; blob_id: string }>();
    if (!victims.length) return false;

    await env.DB.batch(
      victims.map((v) => env.DB.prepare("DELETE FROM clips WHERE id = ?").bind(v.id)),
    );
    await deleteBlobs(env, victims.map((v) => v.blob_id));
    const byUser = new Map<string, string[]>();
    for (const v of victims) byUser.set(v.user_id, [...(byUser.get(v.user_id) ?? []), v.id]);
    for (const [owner, clipIds] of byUser) {
      try {
        await env.SYNC.getByName(owner).broadcastAll(clipIds.map((c) => deletedEvent(c, now)));
      } catch (error) {
        console.error({ msg: "eviction fanout failed", error });
      }
    }
    console.log({ msg: "evicted files to make room", clips: victims.length });
  }
  return false;
}
