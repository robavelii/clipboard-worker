/**
 * Accounts beyond the first (decisions §45).
 *
 * Signup makes an account and its first device, given an email and either a
 * code mailed to that address (when the server's SIGNUP is `open`) or an
 * invite an admin minted with ADMIN_SECRET (any setting). The device then
 * creates the vault as bootstrap's first device does: the passphrase never
 * reaches the server.
 *
 * Sign-in enrols a device into an existing account with no other device at
 * hand: the email, then the passphrase's proof, which the server checks
 * against `auth_hash` exactly as it does before a key change. Devices with
 * another device nearby join by pair code, link or invite instead.
 *
 * Nothing here says whether an address has an account before the caller
 * has shown they read its mail: a code is "sent" either way, and an unknown
 * address gets a salt as stable as a real one.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomSalt } from "@clipsync/crypto";
import type {
  Credentials,
  MintSignupInviteResponse,
  SigninRequest,
  SigninSaltResponse,
  SignupRequest,
} from "@clipsync/protocol";
import { rateLimit } from "../limits";
import { newId, sha256, timingSafeEqual } from "../ids";
import { assertDeviceName, assertPlatform, createDevice } from "./auth";
import type { UserRow } from "../db";

const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const RESEND_AFTER_MS = 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNIN_FAILURES = 10;
const SIGNIN_WINDOW_MS = 60 * 60 * 1000;

/** An address as stored: trimmed and lowercased; null if it isn't one. */
export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\s<>()",;:\\[\]\x00-\x1f\x7f]/.test(email)) return null;
  return /^[^@]{1,64}@[^@]+\.[^@]{2,}$/.test(email) ? email : null;
}

function requireEmail(value: unknown): string {
  const email = normaliseEmail(value);
  if (!email) throw new HTTPException(400, { message: "a valid email address is required" });
  return email;
}

/** Six digits, uniform: rejection sampling, so no digit is likelier than another. */
function sixDigits(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < 4_294_000_000) return String(buf[0]! % 1_000_000).padStart(6, "0");
  }
}

/** A salt for an address with no account, the same on every ask, so the answer reveals nothing. */
async function standInSalt(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`clipsync:signin-salt:${email}`)));
  let s = "";
  for (const b of mac.slice(0, 16)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SIGNUP is typed from wrangler.jsonc's value; a deployment sets it either way. */
const signupOpen = (env: Env): boolean => String(env.SIGNUP) === "open";

export const signupRoutes = new Hono<{ Bindings: Env }>()

  /**
   * Mail a code to `email`. Answers 202 whether or not one went out, and
   * whether or not the address already has an account; at most one mail a
   * minute per address.
   */
  .post("/email", rateLimit("UNAUTH_LIMIT", "signup-email"), async (c) => {
    if (!signupOpen(c.env)) throw new HTTPException(403, { message: "signup is not open on this server" });
    if (!c.env.MAILER) throw new HTTPException(503, { message: "this server has no mail set up" });
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = requireEmail(body.email);
    const now = Date.now();

    const code = sixDigits();
    const stored = await c.env.DB.prepare(
      `INSERT INTO email_codes (email, code_hash, sent_at, expires_at, attempts) VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT(email) DO UPDATE SET code_hash = ?2, sent_at = ?3, expires_at = ?4, attempts = 0
        WHERE email_codes.sent_at < ?5`,
    )
      .bind(email, await sha256(code), now, now + CODE_TTL_MS, now - RESEND_AFTER_MS)
      .run();
    if (stored.meta.changes) {
      await c.env.MAILER.send({
        to: email,
        subject: `Your ClipSync code: ${code}`,
        text: [
          `Your ClipSync code is ${code}.`,
          "",
          "Enter it where you started signing up. It works once, for 15 minutes.",
          "If you didn't ask for it, you can ignore this email: nothing happens without the code.",
        ].join("\n"),
      });
    }
    return c.json({ ok: true }, 202);
  })

  /** An invite for one signup, for whoever holds ADMIN_SECRET. */
  .post("/invites", rateLimit("STRICT_LIMIT", "signup-invite"), async (c) => {
    const body = await c.req.json<{ adminSecret?: unknown }>().catch(() => ({}) as { adminSecret?: unknown });
    if (!c.env.ADMIN_SECRET || typeof body.adminSecret !== "string" || !timingSafeEqual(body.adminSecret, c.env.ADMIN_SECRET)) {
      throw new HTTPException(403, { message: "bad admin secret" });
    }
    const code = `SIGNUP-${newId("x").slice(2).toUpperCase()}`;
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO signup_invites (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(code), now, now + INVITE_TTL_MS)
      .run();
    return c.json<MintSignupInviteResponse>({ code, expiresAt: now + INVITE_TTL_MS });
  })

  /** Make the account and its first device. */
  .post("/", rateLimit("UNAUTH_LIMIT", "signup"), async (c) => {
    const body = await c.req.json<SignupRequest>().catch(() => null);
    if (!body) throw new HTTPException(400, { message: "a JSON body is required" });
    const email = requireEmail(body.email);
    const deviceName = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);
    const now = Date.now();

    const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
    if (taken) throw new HTTPException(409, { message: "this email already has an account -- sign in instead" });

    if (typeof body.invite === "string" && body.invite) {
      const claimed = await c.env.DB.prepare(
        `UPDATE signup_invites SET used_at = ?1
          WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING code_hash`,
      )
        .bind(now, await sha256(body.invite.trim().toUpperCase()))
        .first();
      if (!claimed) throw new HTTPException(400, { message: "invite is invalid, expired or already used" });
    } else if (typeof body.code === "string" && body.code) {
      if (!signupOpen(c.env)) throw new HTTPException(403, { message: "signup is not open on this server" });
      // Each guess is counted before it is judged, so five wrong ones end the code.
      const pending = await c.env.DB.prepare(
        `UPDATE email_codes SET attempts = attempts + 1
          WHERE email = ?1 AND expires_at > ?2 AND attempts < ?3 RETURNING code_hash`,
      )
        .bind(email, now, CODE_ATTEMPTS)
        .first<{ code_hash: string }>();
      if (!pending || !timingSafeEqual(pending.code_hash, await sha256(body.code.trim()))) {
        throw new HTTPException(400, { message: "code is wrong or expired -- ask for a new one" });
      }
      await c.env.DB.prepare("DELETE FROM email_codes WHERE email = ?").bind(email).run();
    } else {
      throw new HTTPException(400, { message: "a code from the email, or an invite, is required" });
    }

    const user: Pick<UserRow, "id" | "kdf_salt"> = { id: newId("usr"), kdf_salt: randomSalt() };
    const inserted = await c.env.DB.prepare(
      `INSERT INTO users (id, kdf_salt, created_at, email, plan)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
    )
      .bind(user.id, user.kdf_salt, now, email, c.env.SIGNUP_PLAN || "free", email)
      .run();
    if (!inserted.meta.changes) throw new HTTPException(409, { message: "this email already has an account -- sign in instead" });

    const { deviceId, token } = await createDevice(c.env.DB, user.id, deviceName, platform);
    return c.json<Credentials>({
      userId: user.id,
      deviceId,
      token,
      kdfSalt: user.kdf_salt,
      wrappedVaultKey: null,
      createdAccount: true,
      keyEpoch: 0,
    });
  });

export const signinRoutes = new Hono<{ Bindings: Env }>()

  /** The salt to derive the passphrase's proof with. */
  .post("/salt", rateLimit("UNAUTH_LIMIT", "signin-salt"), async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = requireEmail(body.email);
    const user = await c.env.DB.prepare("SELECT kdf_salt FROM users WHERE email = ?").bind(email).first<{ kdf_salt: string }>();
    return c.json<SigninSaltResponse>({ kdfSalt: user?.kdf_salt ?? (await standInSalt(c.env.ADMIN_SECRET, email)) });
  })

  /** Enrol this device, given the email and the passphrase's proof. */
  .post("/", rateLimit("UNAUTH_LIMIT", "signin"), async (c) => {
    const body = await c.req.json<SigninRequest>().catch(() => null);
    if (!body || typeof body.authProof !== "string" || !body.authProof) {
      throw new HTTPException(400, { message: "authProof is required" });
    }
    const email = requireEmail(body.email);
    const deviceName = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);
    const now = Date.now();

    const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
      .bind(email)
      .first<UserRow & { signin_failures: number; signin_window: number | null }>();
    const windowOpen = user?.signin_window !== null && user?.signin_window !== undefined && user.signin_window > now - SIGNIN_WINDOW_MS;
    if (user && windowOpen && user.signin_failures >= SIGNIN_FAILURES) {
      throw new HTTPException(429, { message: "too many failed sign-ins for this account -- try again within the hour" });
    }

    const proof = await sha256(body.authProof);
    if (!user || !user.auth_hash || !timingSafeEqual(proof, user.auth_hash)) {
      if (user) {
        await c.env.DB.prepare(
          `UPDATE users SET signin_failures = CASE WHEN signin_window > ?2 THEN signin_failures + 1 ELSE 1 END,
                            signin_window = CASE WHEN signin_window > ?2 THEN signin_window ELSE ?1 END
            WHERE id = ?3`,
        )
          .bind(now, now - SIGNIN_WINDOW_MS, user.id)
          .run();
      }
      throw new HTTPException(403, { message: "the email or the passphrase is wrong" });
    }

    await c.env.DB.prepare("UPDATE users SET signin_failures = 0, signin_window = NULL WHERE id = ?").bind(user.id).run();
    const { deviceId, token } = await createDevice(c.env.DB, user.id, deviceName, platform);
    return c.json<Credentials>({
      userId: user.id,
      deviceId,
      token,
      kdfSalt: user.kdf_salt,
      wrappedVaultKey: user.wrapped_vault_key,
      keyEpoch: user.key_epoch,
    });
  });
