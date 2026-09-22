/**
 * Account bootstrap.
 *
 * This deployment serves exactly one person, so there is no signup flow: the
 * first device proves itself with ADMIN_SECRET (a Wrangler secret) and every
 * later device is added by pairing code. No email, no OAuth app, no password
 * database.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomSalt } from "@clipsync/crypto";
import type {
  BootstrapRequest,
  Credentials,
  Platform,
  WhoAmI,
} from "@clipsync/protocol";
import { requireDevice, type AuthVars } from "../auth";
import { getUser } from "../db";
import { newId, newToken, sha256, timingSafeEqual } from "../ids";

const PLATFORMS: Platform[] = ["linux", "macos", "windows", "web", "other"];

export function assertPlatform(value: unknown): Platform {
  return PLATFORMS.includes(value as Platform) ? (value as Platform) : "other";
}

export function assertDeviceName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 64) {
    throw new HTTPException(400, {
      message: "deviceName must be 1-64 characters",
    });
  }
  return name;
}

/** Issue a device row plus its one-time token. */
export async function createDevice(
  db: D1Database,
  userId: string,
  name: string,
  platform: Platform,
): Promise<{ deviceId: string; token: string }> {
  const deviceId = newId("dev");
  const token = newToken();
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(deviceId, userId, name, platform, await sha256(token), Date.now())
    .run();
  return { deviceId, token };
}

export const authRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

  /**
   * Create the account if it does not exist and enrol the calling device.
   * Repeatable: run it again on a machine that lost its token.
   */
  .post("/bootstrap", async (c) => {
    const expected = c.env.ADMIN_SECRET;
    if (!expected) {
      throw new HTTPException(503, {
        message:
          "ADMIN_SECRET is not configured -- run `wrangler secret put ADMIN_SECRET`",
      });
    }

    const body = await c.req.json<BootstrapRequest>().catch(() => null);
    if (!body || typeof body.adminSecret !== "string") {
      throw new HTTPException(400, { message: "adminSecret is required" });
    }
    if (!timingSafeEqual(body.adminSecret, expected)) {
      throw new HTTPException(403, { message: "bad admin secret" });
    }

    const name = assertDeviceName(body.deviceName);
    const platform = assertPlatform(body.platform);

    let user = await getUser(c.env.DB);
    if (!user) {
      user = {
        id: newId("usr"),
        // Generated once, never rotated: rotating it would orphan every clip
        // already encrypted under the old derivation.
        kdf_salt: randomSalt(),
        created_at: Date.now(),
      };
      await c.env.DB.prepare(
        "INSERT INTO users (id, kdf_salt, created_at) VALUES (?, ?, ?)",
      )
        .bind(user.id, user.kdf_salt, user.created_at)
        .run();
    }

    const { deviceId, token } = await createDevice(
      c.env.DB,
      user.id,
      name,
      platform,
    );

    return c.json<Credentials>({
      userId: user.id,
      deviceId,
      token,
      kdfSalt: user.kdf_salt,
    });
  })

  .get("/me", requireDevice, async (c) => {
    const device = c.var.device;
    const user = await getUser(c.env.DB);
    if (!user) throw new HTTPException(500, { message: "account missing" });

    return c.json<WhoAmI>({
      userId: device.userId,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: assertPlatform(device.platform),
      kdfSalt: user.kdf_salt,
    });
  });
