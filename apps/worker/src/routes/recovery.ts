/**
 * The recovery key (decisions §48): a way back into an account whose
 * passphrase is forgotten, with or without a device left.
 *
 * The recovery key itself never reaches the server. What does (see
 * @clipsync/crypto's recovery.ts): its public key, its private key wrapped
 * under it, the current vault key sealed to that public key, and the
 * SHA-256 of a proof derived from it. None of these opens anything.
 *
 * Setting one takes the passphrase's proof, as setting the address does
 * (§47): a device token alone must not be able to plant a recovery key it
 * holds, since a recovery key resets the passphrase.
 *
 * Recovering is two calls, because the client has to open the vault key
 * before it can wrap it under a new passphrase: /open returns what the
 * recovery key opens, /reset swaps in the new wrap and enrols the device.
 * Both are proven by the recovery proof, and both answer a wrong proof and
 * an unknown address alike.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  STALE_EPOCH_ERROR,
  type ApiError,
  type Credentials,
  type RecoveryOpenRequest,
  type RecoveryOpenResponse,
  type RecoveryResetRequest,
  type RecoveryStatus,
  type SetRecoveryRequest,
} from "@clipsync/protocol";
import type { AuthVars } from "../auth";
import { PUBLIC_KEY_PATTERN, type UserRow } from "../db";
import { sha256, timingSafeEqual } from "../ids";
import { rateLimit } from "../limits";
import { assertDeviceName, assertPlatform, createDevice } from "./auth";
import { requireEmail } from "./signup";

/** The real ones are about 220 (r1) and 180 (d1) characters. */
const MAX_ENVELOPE = 512;
const HASH = /^[A-Za-z0-9_-]{43}$/;

interface RecoveryRow {
  recovery_public_key: string | null;
  recovery_private: string | null;
  recovery_sealed: string | null;
  recovery_epoch: number | null;
  recovery_hash: string | null;
}

function envelope(value: unknown, prefix: string, name: string): string {
  if (typeof value !== "string" || !value.startsWith(`${prefix}.`) || value.length > MAX_ENVELOPE) {
    throw new HTTPException(400, { message: `${name} must be a ${prefix} envelope` });
  }
  return value;
}

function epochOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HTTPException(400, { message: "the epoch must be a whole number" });
  }
  return value;
}

/** The account at `email`, if `proof` is its recovery key's. Null for any mismatch, alike. */
async function provenAccount(db: D1Database, email: string, proof: unknown) {
  if (typeof proof !== "string" || !proof) return null;
  const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow & RecoveryRow>();
  if (!user?.recovery_hash || !timingSafeEqual(await sha256(proof), user.recovery_hash)) return null;
  return user;
}

const wrongKey = () => new HTTPException(403, { message: "the email or the recovery key is wrong" });

/** Under /api/account (which already requires a device): this account's recovery key. */
export const accountRecoveryRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  .get("/", async (c) => {
    const row = await c.env.DB.prepare("SELECT recovery_public_key, recovery_epoch, key_epoch FROM users WHERE id = ?")
      .bind(c.var.device.userId)
      .first<{ recovery_public_key: string | null; recovery_epoch: number | null; key_epoch: number }>();
    if (!row) throw new HTTPException(500, { message: "account missing" });
    return c.json<RecoveryStatus>({ publicKey: row.recovery_public_key, epoch: row.recovery_epoch, keyEpoch: row.key_epoch });
  })

  /** Set or replace it, with the passphrase's proof, for the current vault key. */
  .put("/", async (c) => {
    const body = await c.req.json<Partial<SetRecoveryRequest>>().catch(() => ({}) as Partial<SetRecoveryRequest>);
    if (typeof body.authProof !== "string" || !body.authProof) {
      throw new HTTPException(403, { message: "setting a recovery key requires the passphrase" });
    }
    if (typeof body.publicKey !== "string" || !PUBLIC_KEY_PATTERN.test(body.publicKey)) {
      throw new HTTPException(400, { message: "publicKey must be a raw P-256 point, base64url" });
    }
    const wrapped = envelope(body.wrappedPrivateKey, "r1", "wrappedPrivateKey");
    const sealed = envelope(body.sealed, "d1", "sealed");
    const epoch = epochOf(body.epoch);
    if (typeof body.recoveryHash !== "string" || !HASH.test(body.recoveryHash)) {
      throw new HTTPException(400, { message: "recoveryHash must be a base64url SHA-256" });
    }
    const userId = c.var.device.userId;
    const set = await c.env.DB.prepare(
      `UPDATE users SET recovery_public_key = ?, recovery_private = ?, recovery_sealed = ?,
                        recovery_epoch = ?, recovery_hash = ?
        WHERE id = ? AND auth_hash = ? AND key_epoch = ?`,
    )
      .bind(body.publicKey, wrapped, sealed, epoch, body.recoveryHash, userId, await sha256(body.authProof), epoch)
      .run();
    if (!set.meta.changes) {
      const user = await c.env.DB.prepare("SELECT key_epoch FROM users WHERE id = ?").bind(userId).first<{ key_epoch: number }>();
      if (user && user.key_epoch !== epoch) {
        return c.json<ApiError>(
          { error: STALE_EPOCH_ERROR, message: `the vault is at epoch ${user.key_epoch}, not ${epoch} -- nothing was changed` },
          409,
        );
      }
      throw new HTTPException(403, { message: "that is not this account's passphrase" });
    }
    return c.json({ ok: true });
  })

  /** Remove it, with the passphrase's proof. */
  .delete("/", async (c) => {
    const body = await c.req.json<{ authProof?: unknown }>().catch(() => ({}) as { authProof?: unknown });
    if (typeof body.authProof !== "string" || !body.authProof) {
      throw new HTTPException(403, { message: "removing the recovery key requires the passphrase" });
    }
    const removed = await c.env.DB.prepare(
      `UPDATE users SET recovery_public_key = NULL, recovery_private = NULL, recovery_sealed = NULL,
                        recovery_epoch = NULL, recovery_hash = NULL
        WHERE id = ? AND auth_hash = ?`,
    )
      .bind(c.var.device.userId, await sha256(body.authProof))
      .run();
    if (!removed.meta.changes) throw new HTTPException(403, { message: "that is not this account's passphrase" });
    return c.json({ ok: true });
  });

/** /api/recovery: using a recovery key, with no device or passphrase at hand. */
export const recoveryRoutes = new Hono<{ Bindings: Env }>()

  /** What the recovery key needs to open the vault key. */
  .post("/open", rateLimit("STRICT_LIMIT", "recovery"), async (c) => {
    const body = await c.req.json<Partial<RecoveryOpenRequest>>().catch(() => ({}) as Partial<RecoveryOpenRequest>);
    const user = await provenAccount(c.env.DB, requireEmail(body.email), body.recoveryProof);
    if (!user || !user.recovery_public_key || !user.recovery_private || !user.recovery_sealed || user.recovery_epoch === null) {
      throw wrongKey();
    }
    if (user.recovery_epoch !== user.key_epoch) {
      throw new HTTPException(409, {
        message:
          "this recovery key opens an older vault key than the current one: a re-key left it behind. " +
          "It cannot reset the passphrase; enrol from a device that still holds the vault key instead",
      });
    }
    return c.json<RecoveryOpenResponse>({
      userId: user.id,
      kdfSalt: user.kdf_salt,
      keyEpoch: user.key_epoch,
      publicKey: user.recovery_public_key,
      wrappedPrivateKey: user.recovery_private,
      sealed: user.recovery_sealed,
      epoch: user.recovery_epoch,
    });
  })

  /** A new passphrase, proven by the recovery key, and this device enrolled. */
  .post("/reset", rateLimit("STRICT_LIMIT", "recovery-reset"), async (c) => {
    const body = await c.req.json<Partial<RecoveryResetRequest>>().catch(() => ({}) as Partial<RecoveryResetRequest>);
    const email = requireEmail(body.email);
    const wrapped = envelope(body.wrappedVaultKey, "k1", "wrappedVaultKey");
    if (typeof body.authHash !== "string" || !HASH.test(body.authHash)) {
      throw new HTTPException(400, { message: "authHash must be a base64url SHA-256" });
    }
    const keyEpoch = epochOf(body.keyEpoch);
    const deviceName = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);

    const user = await provenAccount(c.env.DB, email, body.recoveryProof);
    if (!user) throw wrongKey();

    // Guarded on the same proof and epoch, so a recovery key replaced or a
    // re-key landing meanwhile changes nothing.
    const reset = await c.env.DB.prepare(
      `UPDATE users SET wrapped_vault_key = ?, auth_hash = ?, signin_failures = 0, signin_window = NULL
        WHERE id = ? AND recovery_hash = ? AND key_epoch = ?`,
    )
      .bind(wrapped, body.authHash, user.id, user.recovery_hash, keyEpoch)
      .run();
    if (!reset.meta.changes) {
      return c.json<ApiError>(
        { error: STALE_EPOCH_ERROR, message: "the account changed while recovering (a re-key, or a new recovery key) -- try again" },
        409,
      );
    }

    if (body.revokeOtherDevices) {
      const { results } = await c.env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL")
        .bind(user.id)
        .all<{ id: string }>();
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(Date.now(), user.id),
        c.env.DB.prepare("DELETE FROM sealed_vault_keys WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)").bind(user.id),
      ]);
      const room = c.env.SYNC.getByName(user.id);
      for (const { id } of results) {
        await room.disconnect(id).catch((error: unknown) => console.error({ msg: "disconnect on recovery failed", error: String(error) }));
      }
    }

    let enrolled: { deviceId: string; token: string };
    try {
      enrolled = await createDevice(c.env.DB, user.id, deviceName, platform);
    } catch (err) {
      // The reset has happened; only the enrolment didn't. Say so, and how
      // to finish, since "revoke a device" needs a device they may not have.
      if (err instanceof HTTPException && err.status === 403) {
        throw new HTTPException(403, {
          message:
            "the passphrase is reset, but the plan has no room for another device -- " +
            "run the recovery again and sign the other devices out, or revoke one from a device you still have",
        });
      }
      throw err;
    }
    const { deviceId, token } = enrolled;

    // The owner hears of it, in case it was not them: whoever holds the
    // recovery key can do this, and the address is where they would look.
    if (c.env.MAILER && user.email) {
      const mailer = c.env.MAILER;
      const to = user.email;
      c.executionCtx.waitUntil(
        mailer
          .send({
            to,
            subject: "Your ClipSync passphrase was reset with your recovery key",
            text: [
              `Your account's passphrase was just reset with its recovery key, and a device named "${deviceName}" was enrolled.`,
              body.revokeOtherDevices ? "Every other device was signed out." : "Your other devices are unchanged.",
              "",
              "If this wasn't you, someone has your recovery key: sign in with the new passphrase from a device you trust,",
              "revoke the devices you don't recognise, make a new recovery key (clipsync recovery), and re-key (clipsync rekey).",
            ].join("\n"),
          })
          .catch((error: unknown) => console.error({ msg: "recovery notice failed", error: String(error) })),
      );
    }

    return c.json<Credentials>({
      userId: user.id,
      deviceId,
      token,
      kdfSalt: user.kdf_salt,
      wrappedVaultKey: wrapped,
      keyEpoch: user.key_epoch,
    });
  });
