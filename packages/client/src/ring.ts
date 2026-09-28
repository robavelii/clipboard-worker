/**
 * The vault keys a device holds, by epoch.
 *
 * A re-key moves the account to a new vault key, but clips written before it
 * stay under the old one until they are re-encrypted, so a device keeps the
 * keys it has been given and picks the one each clip names. It writes only
 * under the current one.
 */

import {
  DecryptError,
  decryptText,
  vaultKeysFrom,
  type VaultKey,
  type VaultKeys,
} from "@clipsync/crypto";
import type { Clip } from "@clipsync/protocol";

export interface VaultRing {
  /** The epoch new clips are written under. */
  current: number;
  /** Every key this device holds, by epoch (keys are JSON-safe strings). */
  keys: Record<string, VaultKey>;
}

export function ringOf(vaultKey: VaultKey, epoch = 0): VaultRing {
  return { current: epoch, keys: { [String(epoch)]: vaultKey } };
}

/** Add a key; it becomes current if it is the newest. */
export function withKey(ring: VaultRing, epoch: number, vaultKey: VaultKey): VaultRing {
  return {
    current: Math.max(ring.current, epoch),
    keys: { ...ring.keys, [String(epoch)]: vaultKey },
  };
}

export function currentKey(ring: VaultRing): VaultKey {
  const key = ring.keys[String(ring.current)];
  if (!key) throw new Error(`no vault key for the current epoch ${ring.current}`);
  return key;
}

/**
 * The derived keys for every epoch in a ring. Derivation is HKDF only -- no
 * PBKDF2 -- so building this for a handful of epochs costs nothing.
 */
export interface RingKeys {
  current: number;
  byEpoch: ReadonlyMap<number, VaultKeys>;
}

export async function ringKeysFrom(ring: VaultRing, kdfSalt: string): Promise<RingKeys> {
  const entries = await Promise.all(
    Object.entries(ring.keys).map(
      async ([epoch, key]) => [Number(epoch), await vaultKeysFrom(key, kdfSalt)] as const,
    ),
  );
  return { current: ring.current, byEpoch: new Map(entries) };
}

export function currentKeys(keys: RingKeys): VaultKeys {
  const current = keys.byEpoch.get(keys.current);
  if (!current) throw new Error(`no vault key for the current epoch ${keys.current}`);
  return current;
}

/**
 * Decrypt a clip with the key for the epoch it names. Throws DecryptError if
 * this device does not hold that key (it joined after the clip's epoch, and
 * the clip has not been re-encrypted yet) or the envelope does not open.
 */
export async function decryptClip(keys: RingKeys, clip: Pick<Clip, "envelope" | "keyEpoch">): Promise<string> {
  const epochKeys = keys.byEpoch.get(clip.keyEpoch ?? 0);
  if (!epochKeys) {
    // Same error type as a wrong key, so callers have one failure to handle.
    throw new DecryptError(`no key for epoch ${clip.keyEpoch}`);
  }
  return decryptText(epochKeys, clip.envelope);
}
