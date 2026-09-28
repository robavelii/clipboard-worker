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
  dedupeHash,
  openClip,
  sealClip,
  vaultKeysFrom,
  type VaultKey,
  type VaultKeys,
} from "@clipsync/crypto";
import type { Clip, ClipType } from "@clipsync/protocol";

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
 * What an image or file clip's envelope holds: everything needed to fetch,
 * decrypt and check its bytes. The blob's key is here and nowhere else.
 */
export interface FileMeta {
  name: string;
  mime: string;
  /** Plaintext bytes. */
  size: number;
  /** Hex SHA-256 of the plaintext, checked after download. */
  sha256: string;
  /** The blob's own AES-GCM key (see @clipsync/crypto generateBlobKey). */
  key: string;
  blobId: string;
  chunks: number;
}

function isFileMeta(value: unknown): value is FileMeta {
  const m = value as Partial<FileMeta> | null;
  return (
    !!m &&
    typeof m.name === "string" &&
    typeof m.mime === "string" &&
    Number.isSafeInteger(m.size) &&
    typeof m.sha256 === "string" &&
    typeof m.key === "string" &&
    typeof m.blobId === "string" &&
    Number.isSafeInteger(m.chunks)
  );
}

/** A file's dedupe tag is over its digest: the bytes never reach HMAC whole. */
function fileTag(sha256: string): string {
  return `blob:${sha256}`;
}

/** A clip as a device reads it. */
export interface OpenedClip {
  /** The text, or for an image or file its name. */
  text: string;
  /** An image or file clip's metadata; null for text. */
  file: FileMeta | null;
  /**
   * What the envelope itself vouches for: the copying device and its clock
   * at the copy. null for v1 envelopes, which carry no authenticated
   * metadata -- the server's word is all there is for those.
   */
  origin: string | null;
  copiedAt: number | null;
}

type ReadableClip = Pick<Clip, "envelope" | "keyEpoch" | "deviceId" | "type" | "contentHash"> & {
  blobId?: string | null;
};

/**
 * Open a clip with the key for the epoch it names, and check it is the clip
 * the row says it is. Throws DecryptError if this device does not hold that
 * key, the envelope does not open, or -- for v2 -- the authenticated header
 * disagrees with the row, or the dedupe tag is not this plaintext's. Each of
 * those is the server presenting something other than what was written.
 *
 * `account` is the user id this device enrolled into; the envelope is bound
 * to it.
 */
export async function readClip(
  keys: RingKeys,
  clip: ReadableClip,
  account: string,
): Promise<OpenedClip> {
  const epochKeys = keys.byEpoch.get(clip.keyEpoch ?? 0);
  if (!epochKeys) {
    // Same error type as a wrong key, so callers have one failure to handle.
    throw new DecryptError(`no key for epoch ${clip.keyEpoch}`);
  }
  if (!clip.envelope.startsWith("v2.")) {
    // Legacy: readable, but nothing about it is authenticated beyond the text.
    if (clip.type !== "text") throw new DecryptError("image and file clips are always v2");
    return {
      text: await decryptText(epochKeys, clip.envelope),
      file: null,
      origin: null,
      copiedAt: null,
    };
  }
  const { header, payload } = await openClip(epochKeys, account, clip.envelope);
  if (header.device !== clip.deviceId || header.type !== clip.type) {
    throw new DecryptError("the clip's envelope does not match its row");
  }
  const decoded = new TextDecoder().decode(payload);
  const authenticated = { origin: header.device, copiedAt: header.copiedAt };

  if (clip.type === "text") {
    if ((await dedupeHash(epochKeys, decoded)) !== clip.contentHash) {
      throw new DecryptError("the clip's dedupe tag does not match its contents");
    }
    return { text: decoded, file: null, ...authenticated };
  }

  let meta: unknown;
  try {
    meta = JSON.parse(decoded);
  } catch {
    meta = null;
  }
  if (!isFileMeta(meta) || meta.blobId !== clip.blobId) {
    throw new DecryptError("the clip's envelope does not match its blob");
  }
  if ((await dedupeHash(epochKeys, fileTag(meta.sha256))) !== clip.contentHash) {
    throw new DecryptError("the clip's dedupe tag does not match its contents");
  }
  return { text: meta.name, file: meta, ...authenticated };
}

/** {@link readClip}, for callers that only want the text. */
export async function decryptClip(
  keys: RingKeys,
  clip: ReadableClip,
  account: string,
): Promise<string> {
  return (await readClip(keys, clip, account)).text;
}

/** What a device sends to store a text clip. */
export interface SealedText {
  type: ClipType;
  envelope: string;
  contentHash: string;
  size: number;
  keyEpoch: number;
}

/**
 * Encrypt text for storage under the current key, as a v2 envelope naming
 * `device` and now. `copiedAt` is overridden only by re-encryption, which
 * keeps the time the clip was first stored.
 */
export async function sealText(
  keys: RingKeys,
  account: string,
  device: string,
  text: string,
  copiedAt = Date.now(),
): Promise<SealedText> {
  const current = currentKeys(keys);
  return {
    type: "text",
    envelope: await sealClip(current, account, { device, copiedAt, type: "text" }, new TextEncoder().encode(text)),
    contentHash: await dedupeHash(current, text),
    size: new TextEncoder().encode(text).length,
    keyEpoch: keys.current,
  };
}

/** What a device sends to store an image or file clip, once its blob is up. */
export interface SealedFile extends SealedText {
  blobId: string;
}

/**
 * Seal an image or file clip's metadata under the current key. The bytes
 * are already in the blob; this is the row that adopts it.
 */
export async function sealFile(
  keys: RingKeys,
  account: string,
  device: string,
  type: Exclude<ClipType, "text">,
  meta: FileMeta,
  copiedAt = Date.now(),
): Promise<SealedFile> {
  const current = currentKeys(keys);
  return {
    type,
    envelope: await sealClip(
      current,
      account,
      { device, copiedAt, type },
      new TextEncoder().encode(JSON.stringify(meta)),
    ),
    contentHash: await dedupeHash(current, fileTag(meta.sha256)),
    size: meta.size,
    keyEpoch: keys.current,
    blobId: meta.blobId,
  };
}
