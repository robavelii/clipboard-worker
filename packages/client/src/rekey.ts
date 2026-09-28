/**
 * Re-keying the vault, and the device keys that make it reach every device.
 *
 * Shared by the agent, the web UI and the tray so the steps -- and the order
 * the server's guards expect them in -- exist once.
 */

import {
  authHashOf,
  DeviceSealError,
  generateVaultKey,
  openVault,
  openVaultKeyForDevice,
  sealVaultKeyForDevice,
  unwrapVaultKey,
  wrapVaultKey,
  type DeviceKeypair,
} from "@clipsync/crypto";
import {
  MAX_REENCRYPT_BATCH,
  type Device,
  type ReencryptItem,
} from "@clipsync/protocol";
import { ApiRequestError, type ApiClient } from "./index";
import {
  currentKey,
  readClip,
  ringKeysFrom,
  sealFile,
  sealText,
  withKey,
  type VaultRing,
} from "./ring";

/**
 * Register this device's public key so a re-key can seal to it. Returns false
 * against a Worker that predates device keys, so a client can ship before the
 * server does.
 */
export async function registerDeviceKey(
  api: ApiClient,
  publicKey: string,
): Promise<boolean> {
  try {
    await api.setDeviceKey(publicKey);
    return true;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return false;
    throw err;
  }
}

/** The account moved to a key this device was not given a copy of. */
export class NoSealedKeyError extends Error {
  constructor(readonly epoch: number) {
    super(
      `the vault was re-keyed (epoch ${epoch}) without a copy for this device -- ` +
        "enrol it again with `clipsync link` or a fresh invite",
    );
  }
}

/**
 * Pick up a re-key: fetch this device's sealed copy of the current vault key
 * and add it to the ring. Returns the ring as it was when there is nothing
 * newer.
 */
export async function refreshVaultRing(
  api: ApiClient,
  keypair: DeviceKeypair | null,
  deviceId: string,
  ring: VaultRing,
): Promise<VaultRing> {
  const { epoch, sealed } = await api.sealedVaultKey();
  if (ring.keys[String(epoch)]) return ring;
  if (!sealed || !keypair) throw new NoSealedKeyError(epoch);
  let vaultKey: string;
  try {
    vaultKey = await openVaultKeyForDevice(keypair, deviceId, epoch, sealed);
  } catch (err) {
    // Sealed to a keypair this device no longer has: a browser that lost its
    // IndexedDB, a config rewritten since. As stranded as having no copy.
    if (err instanceof DeviceSealError) throw new NoSealedKeyError(epoch);
    throw err;
  }
  return withKey(ring, epoch, vaultKey);
}

export interface ReencryptResult {
  /** Clips moved to the current key by this call. */
  reencrypted: number;
  /** Clips this device cannot read or verify, left where they were. */
  unreadable: number;
}

/**
 * Move every clip still under an older key to the current one.
 *
 * Safe to run again, and from any device holding the old keys: each write is
 * conditional on the clip still being where it was read, so a replay or a
 * device racing this one moves nothing twice. Passes repeat until one moves
 * nothing, because a clip bumped to the top mid-run lands behind the cursor.
 */
export interface VaultContext {
  /** The account id envelopes are bound to (credentials' userId). */
  account: string;
  kdfSalt: string;
  ring: VaultRing;
}

export async function reencryptHistory(
  api: ApiClient,
  { account, kdfSalt, ring }: VaultContext,
  onProgress?: (reencrypted: number) => void,
): Promise<ReencryptResult> {
  const keys = await ringKeysFrom(ring, kdfSalt);
  const unreadable = new Set<string>();
  let reencrypted = 0;

  for (let moved = -1; moved !== 0; ) {
    moved = 0;
    let before: string | number | undefined;
    do {
      const page = await api.listClips(MAX_REENCRYPT_BATCH, before, {
        epochBelow: ring.current,
      });
      const items: ReencryptItem[] = [];
      for (const clip of page.clips) {
        try {
          const opened = await readClip(keys, clip, account);
          // Kept as the device and time it was stored under. For a v1 clip
          // that is the server's word, which re-encryption now vouches for:
          // the price of upgrading history to authenticated envelopes.
          const copiedAt = opened.copiedAt ?? clip.createdAt;
          // An image or file's envelope holds its blob's key; re-sealing that
          // is the whole job -- the bytes in R2 stay as they are.
          const sealed =
            opened.file && clip.type !== "text"
              ? await sealFile(keys, account, clip.deviceId, clip.type, opened.file, copiedAt)
              : await sealText(keys, account, clip.deviceId, opened.text, copiedAt);
          items.push({
            id: clip.id,
            fromEpoch: clip.keyEpoch,
            envelope: sealed.envelope,
            contentHash: sealed.contentHash,
          });
        } catch {
          unreadable.add(clip.id);
        }
      }
      if (items.length) {
        const { updated } = await api.reencryptClips(items);
        moved += updated;
        reencrypted += updated;
        onProgress?.(reencrypted);
      }
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
  }

  return { reencrypted, unreadable: unreadable.size };
}

export interface RekeyOptions {
  /**
   * The rotation has landed and the ring now holds the new key. Store it
   * here: re-encryption can take a while, and a device that loses the new
   * key before it finishes has to fetch its sealed copy back.
   */
  onRotated?: (ring: VaultRing) => void | Promise<void>;
  onProgress?: (reencrypted: number) => void;
}

export interface RekeyResult extends ReencryptResult {
  ring: VaultRing;
  epoch: number;
  /** Active devices that got no copy of the new key: enrol them again. */
  unsealed: Device[];
}

/**
 * Move the account to a fresh vault key, then re-encrypt history under it.
 *
 * Needs the passphrase: the new key is wrapped under it, and the server
 * accepts the rotation only with its proof. Every active device that has
 * registered a public key gets the new key sealed to it; one that has not is
 * reported back, and a revoked one is never offered any.
 */
export async function rekeyVault(
  api: ApiClient,
  { account, kdfSalt, ring }: VaultContext,
  passphrase: string,
  { onRotated, onProgress }: RekeyOptions = {},
): Promise<RekeyResult> {
  const { wrappedVaultKey, keyEpoch } = await api.vaultKey();
  if (!wrappedVaultKey) {
    throw new Error("this account has no wrapped vault key yet -- unlock it once first");
  }
  if (keyEpoch !== ring.current) {
    throw new Error(
      `this device is on epoch ${ring.current} but the vault is at ${keyEpoch} -- ` +
        "it has missed a re-key; restart it to pick the key up first",
    );
  }

  // A wrong passphrase fails here, locally, before anything is sent.
  const opened = await openVault(passphrase, kdfSalt);
  if ((await unwrapVaultKey(opened.kek, wrappedVaultKey)) !== currentKey(ring)) {
    throw new Error("the passphrase opens a different vault key than this device holds");
  }
  const authHash = await authHashOf(opened.authProof);
  // Accounts from before passphrase proofs register one first. Best effort:
  // a conflict surfaces as the rotation's own refusal.
  await api.claimVaultAuth(authHash).catch(() => undefined);

  const { devices } = await api.devices();
  const newKey = generateVaultKey();
  const toEpoch = keyEpoch + 1;
  const sealedKeys = await Promise.all(
    devices
      .filter((d): d is Device & { publicKey: string } => Boolean(d.publicKey))
      .map(async (d) => ({
        deviceId: d.id,
        sealed: await sealVaultKeyForDevice(
          { deviceId: d.id, publicKey: d.publicKey },
          toEpoch,
          newKey,
        ),
      })),
  );

  const rotated = await api.rotateVault({
    fromEpoch: keyEpoch,
    authProof: opened.authProof,
    authHash,
    wrappedVaultKey: await wrapVaultKey(opened.kek, newKey),
    sealedKeys,
  });

  const next = withKey(ring, rotated.epoch, newKey);
  await onRotated?.(next);
  const history = await reencryptHistory(api, { account, kdfSalt, ring: next }, onProgress);
  return {
    ...history,
    ring: next,
    epoch: rotated.epoch,
    unsealed: devices.filter((d) => rotated.unsealed.includes(d.id)),
  };
}
