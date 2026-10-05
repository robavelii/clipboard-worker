/** D1 row shapes and the mappers to the shared wire types. */

import type { Clip, Device, Platform } from "@clipsync/protocol";

export interface UserRow {
  id: string;
  kdf_salt: string;
  /** Sealed under the passphrase-derived KEK. null until migrated. */
  wrapped_vault_key: string | null;
  /** SHA-256 of the passphrase proof. null on accounts that predate it. */
  auth_hash: string | null;
  /** Which vault key is current; each re-key bumps it. */
  key_epoch: number;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  token_hash: string;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  /** Long-term ECDH public key; null until the device registers one. */
  public_key: string | null;
}

export interface ClipRow {
  id: string;
  user_id: string;
  device_id: string;
  type: string;
  envelope: string;
  content_hash: string;
  size: number;
  pinned: number;
  created_at: number;
  expires_at: number | null;
  key_epoch: number;
  blob_id: string | null;
}

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as Platform,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    publicKey: row.public_key,
  };
}

export function toClip(row: ClipRow): Clip {
  return {
    id: row.id,
    deviceId: row.device_id,
    type: row.type as Clip["type"],
    envelope: row.envelope,
    contentHash: row.content_hash,
    size: row.size,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    keyEpoch: row.key_epoch,
    blobId: row.blob_id ?? null,
  };
}

/**
 * The account `id`. Every request that acts for an account names it -- by
 * the calling device, or the code, invite or link it presents -- and reads
 * it here, never "the" account: a server can hold several.
 */
export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/** The account `deviceId` belongs to. */
export async function getUserOfDevice(db: D1Database, deviceId: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT u.* FROM users u JOIN devices d ON d.user_id = u.id WHERE d.id = ?")
    .bind(deviceId)
    .first<UserRow>();
}

/**
 * The admin's account: the one `bootstrap` creates, and enrols the admin
 * secret's devices into. Marked, not the oldest, so that once it is deleted
 * the admin secret makes a new one rather than joining someone else's
 * (decisions §46). Only bootstrap asks for it.
 */
export async function adminUser(db: D1Database): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE admin = 1").first<UserRow>();
}

/** Raw P-256 point, base64url: 65 bytes -> 87 characters. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
