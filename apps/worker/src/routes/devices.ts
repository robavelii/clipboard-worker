/** Device pairing, listing and revocation. */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  Credentials,
  Device,
  PairCodeResponse,
  PairRequest,
  SetDeviceKeyRequest,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { rateLimit } from "../limits";
import { getUser, PUBLIC_KEY_PATTERN, toDevice, type DeviceRow } from "../db";
import { newPairCode, normalisePairCode, sha256 } from "../ids";
import { assertDeviceName, assertPlatform, createDevice } from "./auth";

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

export const deviceRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  /** Mint a single-use pairing code from an already-trusted device. */
  .post("/pair-code", requireDevice, async (c) => {
    const code = newPairCode();
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;

    await c.env.DB.batch([
      // Codes are cheap; expired rows are not worth a cron.
      c.env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(
        Date.now(),
      ),
      c.env.DB.prepare(
        `INSERT INTO pair_codes (code_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(await sha256(code), c.var.device.userId, Date.now(), expiresAt),
    ]);

    return c.json<PairCodeResponse>({ code, expiresAt });
  })

  /**
   * Redeem a pairing code. Unauthenticated by necessity -- the code *is* the
   * credential, so it is single-use and short-lived.
   */
  .post("/pair", rateLimit("UNAUTH_LIMIT", "pair"), async (c) => {
    const body = await c.req.json<PairRequest>().catch(() => null);
    if (!body || typeof body.code !== "string") {
      throw new HTTPException(400, { message: "code is required" });
    }

    const name = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);
    const codeHash = await sha256(normalisePairCode(body.code));

    // Claim the code before issuing anything: the UPDATE is the mutex, so two
    // racing redemptions cannot both win.
    const claimed = await c.env.DB.prepare(
      `UPDATE pair_codes SET used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING user_id`,
    )
      .bind(Date.now(), codeHash, Date.now())
      .first<{ user_id: string }>();

    if (!claimed) {
      throw new HTTPException(400, {
        message: "pairing code is invalid, expired or already used",
      });
    }

    const user = await getUser(c.env.DB);
    if (!user) throw new HTTPException(500, { message: "account missing" });

    const { deviceId, token } = await createDevice(
      c.env.DB,
      claimed.user_id,
      name,
      platform,
    );

    return c.json<Credentials>({
      userId: claimed.user_id,
      deviceId,
      token,
      kdfSalt: user.kdf_salt,
      wrappedVaultKey: user.wrapped_vault_key,
      keyEpoch: user.key_epoch,
    });
  })

  /**
   * Register this device's long-term public key, so a re-key can seal the new
   * vault key to it. Replacing it is allowed: a browser that lost its
   * IndexedDB, or an agent whose config was rewritten, needs a new one, and
   * the token already proves this is the device.
   */
  .put("/me/key", requireDevice, async (c) => {
    const body = await c.req
      .json<Partial<SetDeviceKeyRequest>>()
      .catch(() => ({}) as Partial<SetDeviceKeyRequest>);
    if (
      typeof body.publicKey !== "string" ||
      !PUBLIC_KEY_PATTERN.test(body.publicKey)
    ) {
      throw new HTTPException(400, {
        message: "publicKey must be a raw P-256 point in base64url",
      });
    }
    await c.env.DB.prepare("UPDATE devices SET public_key = ? WHERE id = ?")
      .bind(body.publicKey, c.var.device.deviceId)
      .run();
    return c.json({ ok: true });
  })

  .get("/", requireDevice, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM devices
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC`,
    )
      .bind(c.var.device.userId)
      .all<DeviceRow>();

    const online = new Set(
      await c.env.SYNC.getByName(c.var.device.userId).connected(),
    );

    return c.json<{ devices: Device[] }>({
      devices: results.map((row) => ({
        ...toDevice(row),
        online: online.has(row.id),
      })),
    });
  })

  /** Revoke a lost device. Its token stops resolving immediately. */
  .delete("/:id", requireDevice, async (c) => {
    const id = c.req.param("id");
    if (id === c.var.device.deviceId) {
      throw new HTTPException(400, {
        message: "a device cannot revoke itself",
      });
    }

    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE devices SET revoked_at = ?
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      ).bind(Date.now(), id, c.var.device.userId),
      // Its copy of the current vault key goes too. It could not fetch it
      // without a token anyway; this keeps the table to devices that can.
      c.env.DB.prepare(
        `DELETE FROM sealed_vault_keys WHERE device_id = ?
           AND device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
      ).bind(id, c.var.device.userId),
    ]);

    if (!res?.meta.changes) {
      throw new HTTPException(404, { message: "device not found" });
    }

    // The token no longer resolves, but a socket opened before this moment
    // would keep receiving clips. Awaited rather than deferred, so "revoked"
    // in the response means the device has actually been cut off.
    try {
      await c.env.SYNC.getByName(c.var.device.userId).disconnect(id);
    } catch (error) {
      console.error({ msg: "disconnect on revoke failed", deviceId: id, error });
    }
    return c.json({ ok: true });
  });
