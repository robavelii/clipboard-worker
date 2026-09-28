/**
 * The account's wrapped vault key.
 *
 * Opaque to the server in both directions: it is handed out to any
 * authenticated device, because a device that can read the clipboard can
 * already read everything the key protects. What the server cannot do is open
 * it.
 *
 * Replacing it is another matter. Any device holding the vault key could wrap
 * it under a passphrase of its own, and devices joined by link or invite hold
 * the vault key without knowing the passphrase. So once a key is set, a new
 * one is accepted only with proof of the current passphrase: an HKDF branch
 * off the passphrase (see openVault in @clipsync/crypto) whose SHA-256 the
 * server keeps in users.auth_hash. Storing that hash gives the server no new
 * oracle: the wrapped key already tests a passphrase guess at the same cost.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  ClaimVaultAuthRequest,
  ClaimVaultAuthResponse,
  PutVaultKeyRequest,
  VaultKeyResponse,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { getUser } from "../db";
import { sha256 } from "../ids";

/** `k1.<iv>.<ciphertext>` — generous ceiling, the real thing is ~90 chars. */
const MAX_WRAPPED_LENGTH = 512;

/** SHA-256, base64url: 43 characters. */
const AUTH_HASH = /^[A-Za-z0-9_-]{43}$/;

function assertAuthHash(value: unknown): string {
  if (typeof value !== "string" || !AUTH_HASH.test(value)) {
    throw new HTTPException(400, {
      message: "authHash must be a base64url SHA-256",
    });
  }
  return value;
}

export const vaultRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  .use("*", requireDevice)

  .get("/key", async (c) => {
    const user = await getUser(c.env.DB);
    if (!user) throw new HTTPException(500, { message: "account missing" });
    return c.json<VaultKeyResponse>({
      kdfSalt: user.kdf_salt,
      wrappedVaultKey: user.wrapped_vault_key,
    });
  })

  /**
   * Write the wrapped key.
   *
   * The first write -- a new account, or one migrating from the pre-vault-key
   * scheme -- has nothing to prove against and sets the proof hash alongside.
   * Every later write is a passphrase change and must carry the current
   * passphrase's proof. Both are single conditional UPDATEs, so a wrong proof
   * and a lost race look the same: nothing written.
   */
  .put("/key", async (c) => {
    const body = await c.req
      .json<Partial<PutVaultKeyRequest>>()
      .catch(() => ({}) as Partial<PutVaultKeyRequest>);

    const wrapped = body.wrappedVaultKey;
    if (
      typeof wrapped !== "string" ||
      !wrapped.startsWith("k1.") ||
      wrapped.length > MAX_WRAPPED_LENGTH
    ) {
      throw new HTTPException(400, {
        message: "wrappedVaultKey must be a k1 envelope",
      });
    }
    const authHash = assertAuthHash(body.authHash);
    const userId = c.var.device.userId;

    const first = await c.env.DB.prepare(
      `UPDATE users SET wrapped_vault_key = ?, auth_hash = ?
        WHERE id = ? AND wrapped_vault_key IS NULL`,
    )
      .bind(wrapped, authHash, userId)
      .run();
    if (first.meta.changes) return c.json({ ok: true });

    if (typeof body.authProof !== "string" || !body.authProof) {
      throw new HTTPException(403, {
        message: "replacing the vault key requires the current passphrase",
      });
    }

    const rotated = await c.env.DB.prepare(
      `UPDATE users SET wrapped_vault_key = ?, auth_hash = ?
        WHERE id = ? AND auth_hash = ?`,
    )
      .bind(wrapped, authHash, userId, await sha256(body.authProof))
      .run();
    if (!rotated.meta.changes) {
      throw new HTTPException(403, {
        message: "that is not the current passphrase",
      });
    }

    return c.json({ ok: true });
  })

  /**
   * Register the passphrase proof on an account that predates it.
   *
   * Trust on first use: the server cannot check a proof it has never seen, so
   * the first claim wins. Clients claim on every passphrase unlock, which
   * closes the window at the owner's next unlock -- and a claim that finds a
   * different hash already registered is how the owner learns someone beat
   * them to it.
   */
  .post("/auth", async (c) => {
    const body = await c.req
      .json<Partial<ClaimVaultAuthRequest>>()
      .catch(() => ({}) as Partial<ClaimVaultAuthRequest>);
    const authHash = assertAuthHash(body.authHash);
    const userId = c.var.device.userId;

    const claimed = await c.env.DB.prepare(
      `UPDATE users SET auth_hash = ?
        WHERE id = ? AND auth_hash IS NULL AND wrapped_vault_key IS NOT NULL`,
    )
      .bind(authHash, userId)
      .run();
    if (claimed.meta.changes) {
      return c.json<ClaimVaultAuthResponse>({ claimed: true });
    }

    const row = await c.env.DB.prepare(
      "SELECT auth_hash, wrapped_vault_key FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ auth_hash: string | null; wrapped_vault_key: string | null }>();

    if (row?.auth_hash === authHash) {
      return c.json<ClaimVaultAuthResponse>({ claimed: false });
    }
    throw new HTTPException(409, {
      message: row?.wrapped_vault_key
        ? "a different passphrase is already registered for this account"
        : "the account has no vault key yet",
    });
  });
