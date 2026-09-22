/**
 * Bearer-token authentication.
 *
 * Tokens are random 256-bit strings issued at bootstrap or pair time and
 * stored only as SHA-256 digests, so a database leak does not yield usable
 * credentials. Lookup is by hashed index -- no linear scan, no timing leak.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { DeviceRow } from "./db";
import { sha256 } from "./ids";

export interface AuthedDevice {
  userId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
}

export type AuthVars = { device: AuthedDevice };

export async function resolveToken(
  db: D1Database,
  token: string,
): Promise<AuthedDevice | null> {
  const row = await db
    .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256(token))
    .first<DeviceRow>();

  if (!row) return null;
  return {
    userId: row.user_id,
    deviceId: row.id,
    deviceName: row.name,
    platform: row.platform,
  };
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}

/** Requires a valid device token; puts the device on `c.var.device`. */
export const requireDevice = createMiddleware<{
  Bindings: Env;
  Variables: AuthVars;
}>(async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) {
    throw new HTTPException(401, { message: "missing bearer token" });
  }

  const device = await resolveToken(c.env.DB, token);
  if (!device) {
    throw new HTTPException(401, { message: "invalid or revoked token" });
  }

  c.set("device", device);

  // Presence bookkeeping is never worth delaying a response for.
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?")
      .bind(Date.now(), device.deviceId)
      .run(),
  );

  await next();
});
