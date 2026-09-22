/**
 * Scan-to-join invites.
 *
 * The counterpart to /api/link for devices that have a camera but no agent --
 * which is every phone. The set-up device seals the vault key under a secret
 * carried only by the QR; this endpoint stores the ciphertext and hands it to
 * whoever can prove they scanned it.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  CreateInviteRequest,
  CreateInviteResponse,
  ClaimInviteRequest,
  ClaimInviteResponse,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { getUser } from "../db";
import { newId } from "../ids";
import { assertDeviceName, assertPlatform, createDevice } from "./auth";

/**
 * Short by design: for its lifetime the QR on screen *is* the credential, so
 * the window in which a photograph of it is useful should be small.
 */
const INVITE_TTL_MS = 5 * 60 * 1000;

const MAX_SEALED_LENGTH = 512;

interface InviteRow {
  id: string;
  user_id: string;
  proof_hash: string;
  sealed_vault_key: string;
  expires_at: number;
  claimed_at: number | null;
}

export const inviteRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  /** Set-up device: publish a sealed vault key for one scan. */
  .post("/", requireDevice, async (c) => {
    const body = await c.req.json<CreateInviteRequest>().catch(() => null);
    if (
      !body ||
      typeof body.sealedVaultKey !== "string" ||
      !body.sealedVaultKey.startsWith("i1.") ||
      body.sealedVaultKey.length > MAX_SEALED_LENGTH ||
      typeof body.proofHash !== "string" ||
      !body.proofHash
    ) {
      throw new HTTPException(400, {
        message: "sealedVaultKey (i1 envelope) and proofHash are required",
      });
    }

    const now = Date.now();
    const id = newId("inv");

    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(now),
      c.env.DB.prepare(
        `INSERT INTO invites
           (id, user_id, proof_hash, sealed_vault_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        c.var.device.userId,
        body.proofHash,
        body.sealedVaultKey,
        now,
        now + INVITE_TTL_MS,
      ),
    ]);

    return c.json<CreateInviteResponse>({
      inviteId: id,
      expiresAt: now + INVITE_TTL_MS,
    });
  })

  /**
   * Scanning device: redeem it.
   *
   * Unauthenticated by necessity -- the device has no token yet. The proof is
   * the credential, and the claim is the mutex, so a second scan of the same
   * QR finds nothing.
   */
  .post("/:id/claim", async (c) => {
    const body = await c.req.json<ClaimInviteRequest>().catch(() => null);
    if (!body || typeof body.proof !== "string" || !body.proof) {
      throw new HTTPException(400, { message: "proof is required" });
    }

    const deviceName = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);
    const now = Date.now();

    const claimed = await c.env.DB.prepare(
      `UPDATE invites SET claimed_at = ?
        WHERE id = ? AND proof_hash = ? AND claimed_at IS NULL AND expires_at > ?
        RETURNING user_id, sealed_vault_key`,
    )
      .bind(now, c.req.param("id"), body.proof, now)
      .first<Pick<InviteRow, "user_id" | "sealed_vault_key">>();

    if (!claimed) {
      throw new HTTPException(404, {
        message: "invite is invalid, expired or already used",
      });
    }

    const user = await getUser(c.env.DB);
    if (!user) throw new HTTPException(500, { message: "account missing" });

    const { deviceId, token } = await createDevice(
      c.env.DB,
      claimed.user_id,
      deviceName,
      platform,
    );

    return c.json<ClaimInviteResponse>({
      sealedVaultKey: claimed.sealed_vault_key,
      credentials: {
        userId: claimed.user_id,
        deviceId,
        token,
        kdfSalt: user.kdf_salt,
        wrappedVaultKey: user.wrapped_vault_key,
      },
    });
  });
