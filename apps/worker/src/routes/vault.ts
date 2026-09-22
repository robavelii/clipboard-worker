/**
 * The account's wrapped vault key.
 *
 * Opaque to the server in both directions: it is handed out to any
 * authenticated device and replaced by any authenticated device, because a
 * device that can read the clipboard can already read everything the key
 * protects. What the server cannot do is open it.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { VaultKeyResponse } from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { getUser } from "../db";

/** `k1.<iv>.<ciphertext>` — generous ceiling, the real thing is ~90 chars. */
const MAX_WRAPPED_LENGTH = 512;

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
   * Write the wrapped key. Used both to migrate an account that predates it
   * and to complete a passphrase change.
   *
   * Last write wins. Concurrent migrations are harmless: every device wraps
   * the same vault key, only the nonce differs.
   */
  .put("/key", async (c) => {
    const body = await c.req
      .json<{ wrappedVaultKey?: string }>()
      .catch(() => ({}) as { wrappedVaultKey?: string });

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

    await c.env.DB.prepare("UPDATE users SET wrapped_vault_key = ? WHERE id = ?")
      .bind(wrapped, c.var.device.userId)
      .run();

    return c.json({ ok: true });
  });
