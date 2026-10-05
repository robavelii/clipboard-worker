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
 *   - storage                      a ceiling on bytes held; the uploader's
 *                                  oldest unpinned files are deleted to make room
 *   - deletes                      free, never refused
 *
 * The budgets are Worker vars (wrangler.jsonc), half the free tier by default.
 * Each account's plan (plans.ts) may set its own, lower limits on all three;
 * the Worker's budgets stay the outer guard (decisions §44).
 */

import type { SyncEvent } from "@clipsync/protocol";
import type { Plan } from "./plans";

/** Whose R2 use a call counts against: an authenticated device carries both. */
export interface Account {
  userId: string;
  plan: Plan;
}

/** Where chunk `idx` of blob `id` lives in the bucket. */
export function chunkKey(id: string, idx: number): string {
  return `blobs/${id}/${idx}`;
}

function monthOf(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Count `n` operations of a class against this month's budgets, the
 * Worker's and the account's, before making them. False when either would
 * be exceeded: the caller refuses the request and nothing is spent.
 *
 * One batch, so one transaction and one round trip (decisions §31). The
 * conditional UPDATE of the Worker's count is the check, for both budgets,
 * so two racing requests cannot both take the last unit. It also stamps the
 * row with this call's marker, and the account's count moves only when the
 * stamp is this call's: the two counts move together or not at all.
 */
export async function spend(
  env: Env,
  account: Account,
  cls: "a" | "b",
  n = 1,
  now = Date.now(),
): Promise<boolean> {
  const month = monthOf(now);
  const column = cls === "a" ? "class_a" : "class_b";
  const budget = Number(cls === "a" ? env.R2_CLASS_A_BUDGET : env.R2_CLASS_B_BUDGET);
  const limit = cls === "a" ? account.plan.classA : account.plan.classB;
  const marker = crypto.randomUUID();
  const [, , spent] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO r2_usage (month) VALUES (?)").bind(month),
    env.DB.prepare("INSERT OR IGNORE INTO account_usage (user_id, month) VALUES (?, ?)").bind(account.userId, month),
    env.DB.prepare(
      `UPDATE r2_usage SET ${column} = ${column} + ?1, last_spend = ?2
        WHERE month = ?3 AND ${column} + ?1 <= ?4
          AND (?5 IS NULL
               OR (SELECT a.${column} FROM account_usage a WHERE a.user_id = ?6 AND a.month = ?3) + ?1 <= ?5)`,
    ).bind(n, marker, month, budget, limit, account.userId),
    env.DB.prepare(
      `UPDATE account_usage SET ${column} = ${column} + ?1
        WHERE user_id = ?2 AND month = ?3
          AND (SELECT last_spend FROM r2_usage WHERE month = ?3) = ?4`,
    ).bind(n, account.userId, month, marker),
  ]);
  return (spent?.meta.changes ?? 0) > 0;
}

/** This month's use and budgets: the Worker's, and the account's under its plan. */
export async function usage(env: Env, account: Account, now = Date.now()) {
  const month = monthOf(now);
  const [ops, stored, mine, myStored] = await env.DB.batch([
    env.DB.prepare("SELECT class_a, class_b FROM r2_usage WHERE month = ?").bind(month),
    env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs"),
    env.DB.prepare("SELECT class_a, class_b FROM account_usage WHERE user_id = ? AND month = ?").bind(
      account.userId,
      month,
    ),
    env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE user_id = ?").bind(account.userId),
  ]);
  const row = (ops?.results[0] ?? {}) as { class_a?: number; class_b?: number };
  const own = (mine?.results[0] ?? {}) as { class_a?: number; class_b?: number };
  return {
    month,
    storedBytes: ((stored?.results[0] ?? {}) as { bytes?: number }).bytes ?? 0,
    storageBudgetBytes: Number(env.R2_STORAGE_BUDGET_BYTES),
    classA: row.class_a ?? 0,
    classABudget: Number(env.R2_CLASS_A_BUDGET),
    classB: row.class_b ?? 0,
    classBBudget: Number(env.R2_CLASS_B_BUDGET),
    account: {
      plan: account.plan.name,
      storedBytes: ((myStored?.results[0] ?? {}) as { bytes?: number }).bytes ?? 0,
      storageBytes: account.plan.storageBytes,
      classA: own.class_a ?? 0,
      classABudget: account.plan.classA,
      classB: own.class_b ?? 0,
      classBBudget: account.plan.classB,
    },
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
 * Reserve `bytes` of storage for a new blob, deleting the uploader's own
 * oldest unpinned image and file clips while it does not fit -- never another
 * account's. Returns false when nothing of the uploader's is left to evict.
 *
 * The insert is conditional on the total, so concurrent uploads cannot
 * together overshoot the ceiling; a loser evicts again and retries.
 */
export async function reserveBlob(
  env: Env,
  account: Account,
  id: string,
  chunks: number,
  bytes: number,
  now = Date.now(),
): Promise<boolean> {
  const { userId } = account;
  const budget = Number(env.R2_STORAGE_BUDGET_BYTES);
  const quota = account.plan.storageBytes;
  if (bytes > budget || (quota !== null && bytes > quota)) return false;

  for (let attempt = 0; attempt < 20; attempt++) {
    // Under the Worker's ceiling and the account's quota at once.
    const inserted = await env.DB.prepare(
      `INSERT INTO blobs (id, user_id, chunks, size, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COALESCE(SUM(size), 0) FROM blobs) + ?4 <= ?6
          AND (?7 IS NULL OR (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE user_id = ?2) + ?4 <= ?7)`,
    )
      .bind(id, userId, chunks, bytes, now, budget, quota)
      .run();
    if (inserted.meta.changes) return true;

    // Oldest first: the files least likely to still be wanted. Only the
    // uploader's: one account's upload must never cost another its files.
    const { results: victims } = await env.DB.prepare(
      `SELECT c.id, c.blob_id FROM clips c
        WHERE c.user_id = ? AND c.blob_id IS NOT NULL AND c.pinned = 0
        ORDER BY c.created_at ASC LIMIT 10`,
    )
      .bind(userId)
      .all<{ id: string; blob_id: string }>();
    if (!victims.length) return false;

    await env.DB.batch(
      victims.map((v) => env.DB.prepare("DELETE FROM clips WHERE id = ? AND user_id = ?").bind(v.id, userId)),
    );
    await deleteBlobs(env, victims.map((v) => v.blob_id));
    try {
      await env.SYNC.getByName(userId).broadcastAll(victims.map((v) => deletedEvent(v.id, now)));
    } catch (error) {
      console.error({ msg: "eviction fanout failed", error });
    }
    console.log({ msg: "evicted files to make room", clips: victims.length });
  }
  return false;
}
