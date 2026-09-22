/**
 * Device linking.
 *
 * Replaces "read a code aloud, then type the passphrase again" with "scan a
 * QR, confirm a fingerprint". The server is a relay: it carries two public
 * keys and one ciphertext, and can open none of it.
 *
 * Three actors, so three endpoints plus a claim:
 *   request  -- joining device publishes its ephemeral public key
 *   get      -- approving device reads it back to show a fingerprint
 *   approve  -- approving device returns a sealed secret and enrols the device
 *   claim    -- joining device collects the result exactly once
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  LinkApproveRequest,
  LinkClaimResponse,
  LinkRequest,
  LinkRequestResponse,
  LinkStatusResponse,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { getUser } from "../db";
import { newId, newToken, sha256 } from "../ids";
import { assertDeviceName, assertPlatform, createDevice } from "./auth";

const LINK_TTL_MS = 10 * 60 * 1000;

/** Cheap flood guard: this endpoint is necessarily unauthenticated. */
const MAX_PENDING = 20;

/** Raw P-256 point is 65 bytes -> 87 base64url characters. */
const PUBLIC_KEY_LENGTH = 87;

interface LinkRow {
  id: string;
  public_key: string;
  device_name: string;
  platform: string;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  approver_public_key: string | null;
  wrapped_secret: string | null;
  device_id: string | null;
  device_token: string | null;
}

function assertPublicKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== PUBLIC_KEY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new HTTPException(400, {
      message: "publicKey must be a raw P-256 point in base64url",
    });
  }
  return value;
}

export const linkRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  /** Joining device: publish an ephemeral public key, get a pickup token. */
  .post("/request", async (c) => {
    const body = await c.req.json<LinkRequest>().catch(() => null);
    if (!body) throw new HTTPException(400, { message: "body required" });

    const publicKey = assertPublicKey(body.publicKey);
    const deviceName = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);
    const now = Date.now();

    await c.env.DB.prepare("DELETE FROM link_requests WHERE expires_at < ?")
      .bind(now)
      .run();

    const pending = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM link_requests WHERE approved_at IS NULL",
    ).first<{ n: number }>();

    if ((pending?.n ?? 0) >= MAX_PENDING) {
      throw new HTTPException(429, {
        message: "too many pending link requests -- try again shortly",
      });
    }

    const id = newId("link");
    const pickupToken = newToken();
    const expiresAt = now + LINK_TTL_MS;

    await c.env.DB.prepare(
      `INSERT INTO link_requests
         (id, public_key, device_name, platform, pickup_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        publicKey,
        deviceName,
        platform,
        await sha256(pickupToken),
        now,
        expiresAt,
      )
      .run();

    return c.json<LinkRequestResponse>({ linkId: id, pickupToken, expiresAt });
  })

  /**
   * Approving device: read back the key it is about to seal to.
   *
   * The response is what the approver shows a fingerprint of. If the server
   * lied here, that fingerprint will not match the one on the joining device's
   * screen, which is the entire point of showing it.
   */
  .get("/:id", requireDevice, async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM link_requests WHERE id = ? AND expires_at > ?",
    )
      .bind(c.req.param("id"), Date.now())
      .first<LinkRow>();

    if (!row) {
      throw new HTTPException(404, {
        message: "link request not found or expired",
      });
    }
    if (row.approved_at) {
      throw new HTTPException(409, { message: "already approved" });
    }

    return c.json<LinkStatusResponse>({
      linkId: row.id,
      publicKey: row.public_key,
      deviceName: row.device_name,
      platform: assertPlatform(row.platform),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    });
  })

  /** Approving device: enrol the device and hand back the sealed secret. */
  .post("/:id/approve", requireDevice, async (c) => {
    const body = await c.req.json<LinkApproveRequest>().catch(() => null);
    if (
      !body ||
      typeof body.wrappedSecret !== "string" ||
      !body.wrappedSecret
    ) {
      throw new HTTPException(400, { message: "wrappedSecret is required" });
    }
    const approverPublicKey = assertPublicKey(body.approverPublicKey);

    // Claim the request before enrolling anything, so two approvals cannot
    // both mint a device.
    const claimed = await c.env.DB.prepare(
      `UPDATE link_requests SET approved_at = ?
        WHERE id = ? AND approved_at IS NULL AND expires_at > ?
        RETURNING device_name, platform`,
    )
      .bind(Date.now(), c.req.param("id"), Date.now())
      .first<{ device_name: string; platform: string }>();

    if (!claimed) {
      throw new HTTPException(404, {
        message: "link request not found, expired or already approved",
      });
    }

    const { deviceId, token } = await createDevice(
      c.env.DB,
      c.var.device.userId,
      claimed.device_name,
      assertPlatform(claimed.platform),
    );

    await c.env.DB.prepare(
      `UPDATE link_requests
          SET approver_public_key = ?, wrapped_secret = ?, device_id = ?, device_token = ?
        WHERE id = ?`,
    )
      .bind(
        approverPublicKey,
        body.wrappedSecret,
        deviceId,
        token,
        c.req.param("id"),
      )
      .run();

    return c.json({ ok: true, deviceId, deviceName: claimed.device_name });
  })

  /**
   * Joining device: collect the result. Unauthenticated by necessity -- the
   * device has no token yet -- so the pickup token is the credential, and the
   * read deletes the row.
   */
  .post("/:id/claim", async (c) => {
    const body = await c.req
      .json<{ pickupToken?: string }>()
      .catch(() => ({}) as { pickupToken?: string });

    if (!body.pickupToken) {
      throw new HTTPException(400, { message: "pickupToken is required" });
    }

    const row = await c.env.DB.prepare(
      "SELECT * FROM link_requests WHERE id = ? AND pickup_hash = ? AND expires_at > ?",
    )
      .bind(c.req.param("id"), await sha256(body.pickupToken), Date.now())
      .first<LinkRow>();

    if (!row) {
      throw new HTTPException(404, {
        message: "link request not found or expired",
      });
    }

    if (!row.approved_at || !row.device_token) {
      return c.json<LinkClaimResponse>({ status: "pending" }, 202);
    }

    const user = await getUser(c.env.DB);
    if (!user) throw new HTTPException(500, { message: "account missing" });

    // Single use: the row goes away with the answer.
    await c.env.DB.prepare("DELETE FROM link_requests WHERE id = ?")
      .bind(row.id)
      .run();

    return c.json<LinkClaimResponse>({
      status: "approved",
      approverPublicKey: row.approver_public_key!,
      wrappedSecret: row.wrapped_secret!,
      credentials: {
        userId: user.id,
        deviceId: row.device_id!,
        token: row.device_token,
        kdfSalt: user.kdf_salt,
        wrappedVaultKey: user.wrapped_vault_key,
      },
    });
  });
