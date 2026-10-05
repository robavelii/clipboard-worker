/**
 * The calling device's account as a whole (decisions §46): exporting it,
 * and deleting it.
 *
 * Deleting needs more than the device token, so a stolen device cannot
 * erase an account: the passphrase's proof, or a code mailed to the
 * account's address (so a device that joined by link or invite, which has
 * the vault key but not the passphrase, can still do it).
 *
 * The export is the account as the server holds it: ciphertext, readable by
 * nobody without the vault key. `clipsync export` decrypts it on a device.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AccountExport, DeleteAccountRequest } from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { toClip, toDevice, type ClipRow, type DeviceRow, type UserRow } from "../db";
import { sha256, timingSafeEqual } from "../ids";
import { deleteBlobs } from "../r2";
import { sixDigits } from "./signup";

const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const RESEND_AFTER_MS = 60 * 1000;

/**
 * Remove an account and everything it holds. Its files' R2 objects go first,
 * while their ids can still be read; then the rows, in one batch: the user
 * row cascades to devices (and their sealed keys), clips, blobs, codes,
 * tickets, invites and usage. Approved link requests have no foreign key to
 * the account and can hold a sealed vault key, so they go by device. Last,
 * the sockets close: with the tokens already gone, nothing can reconnect.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const [devices, blobs] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM devices WHERE user_id = ?").bind(userId),
    env.DB.prepare("SELECT id FROM blobs WHERE user_id = ?").bind(userId),
  ]);
  const deviceIds = ((devices?.results ?? []) as { id: string }[]).map((d) => d.id);
  await deleteBlobs(env, ((blobs?.results ?? []) as { id: string }[]).map((b) => b.id));

  await env.DB.batch([
    env.DB.prepare("DELETE FROM link_requests WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM email_codes WHERE email = (SELECT email FROM users WHERE id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);

  const room = env.SYNC.getByName(userId);
  for (const id of deviceIds) {
    await room.disconnect(id).catch((error: unknown) => console.error({ msg: "disconnect after deletion failed", error: String(error) }));
  }
}

export const accountRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  .use("*", requireDevice)

  /** Mail a code that confirms deleting this account, to its address. */
  .post("/deletion-code", async (c) => {
    const userId = c.var.device.userId;
    const user = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string | null }>();
    if (!user?.email) {
      throw new HTTPException(400, { message: "this account has no email address -- confirm with the passphrase instead" });
    }
    if (!c.env.MAILER) throw new HTTPException(503, { message: "this server has no mail set up -- confirm with the passphrase instead" });

    const code = sixDigits();
    const now = Date.now();
    const stored = await c.env.DB.prepare(
      `INSERT INTO deletion_codes (user_id, code_hash, sent_at, expires_at, attempts) VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT(user_id) DO UPDATE SET code_hash = ?2, sent_at = ?3, expires_at = ?4, attempts = 0
        WHERE deletion_codes.sent_at < ?5`,
    )
      .bind(userId, await sha256(code), now, now + CODE_TTL_MS, now - RESEND_AFTER_MS)
      .run();
    if (stored.meta.changes) {
      await c.env.MAILER.send({
        to: user.email,
        subject: `Delete your ClipSync account: ${code}`,
        text: [
          `Someone, from your device "${c.var.device.deviceName}", asked to delete your ClipSync account.`,
          "",
          `If it was you, the code is ${code}. It works once, for 15 minutes.`,
          "Deleting removes every clip, file and device in the account, for good.",
          "If it wasn't you, ignore this email: nothing is deleted without the code.",
        ].join("\n"),
      });
    }
    return c.json({ ok: true }, 202);
  })

  /** Delete this account, given the passphrase's proof or the mailed code. */
  .delete("/", async (c) => {
    const userId = c.var.device.userId;
    const body = await c.req.json<DeleteAccountRequest>().catch(() => ({}) as DeleteAccountRequest);

    if (typeof body.authProof === "string" && body.authProof) {
      const user = await c.env.DB.prepare("SELECT auth_hash FROM users WHERE id = ?").bind(userId).first<Pick<UserRow, "auth_hash">>();
      if (!user?.auth_hash || !timingSafeEqual(await sha256(body.authProof), user.auth_hash)) {
        throw new HTTPException(403, { message: "that is not this account's passphrase" });
      }
    } else if (typeof body.emailCode === "string" && body.emailCode) {
      // Each guess is counted before it is judged, so five wrong ones end the code.
      const pending = await c.env.DB.prepare(
        `UPDATE deletion_codes SET attempts = attempts + 1
          WHERE user_id = ?1 AND expires_at > ?2 AND attempts < ?3 RETURNING code_hash`,
      )
        .bind(userId, Date.now(), CODE_ATTEMPTS)
        .first<{ code_hash: string }>();
      if (!pending || !timingSafeEqual(pending.code_hash, await sha256(body.emailCode.trim()))) {
        throw new HTTPException(403, { message: "the code is wrong or expired -- ask for a new one" });
      }
    } else {
      throw new HTTPException(400, { message: "the passphrase's proof, or the code from the email, is required" });
    }

    await deleteAccount(c.env, userId);
    return c.json({ ok: true });
  })

  /** The account as the server holds it: ciphertext and metadata, no keys in the clear. */
  .get("/export", async (c) => {
    const userId = c.var.device.userId;
    const [user, devices, clips, blobs] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId),
      c.env.DB.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at").bind(userId),
      c.env.DB.prepare("SELECT * FROM clips WHERE user_id = ? ORDER BY created_at, id").bind(userId),
      c.env.DB.prepare("SELECT id, chunks, size FROM blobs WHERE user_id = ? AND attached_at IS NOT NULL").bind(userId),
    ]);
    const account = (user?.results[0] ?? null) as (UserRow & { email: string | null; plan: string }) | null;
    if (!account) throw new HTTPException(404, { message: "account not found" });
    return c.json<AccountExport>({
      version: 1,
      exportedAt: Date.now(),
      account: {
        id: account.id,
        email: account.email,
        plan: account.plan,
        createdAt: account.created_at,
        kdfSalt: account.kdf_salt,
        wrappedVaultKey: account.wrapped_vault_key,
        keyEpoch: account.key_epoch,
      },
      devices: ((devices?.results ?? []) as DeviceRow[]).map(toDevice),
      clips: ((clips?.results ?? []) as ClipRow[]).map(toClip),
      blobs: (blobs?.results ?? []) as { id: string; chunks: number; size: number }[],
    });
  });
