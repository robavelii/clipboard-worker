/**
 * The recovery key: a way back into the vault when the passphrase is
 * forgotten and no device that holds the vault key is left (decisions §48).
 *
 * It is 32 random bytes, shown to the owner once as text and never sent
 * anywhere. From it come two things, by HKDF:
 *
 *   recovery key --HKDF("clipsync:recovery-kek:v1")--> wraps a P-256 private key
 *                `--HKDF("clipsync:recovery-auth:v1")-> recovery proof (server keeps SHA-256)
 *
 * The keypair is what makes it last. A re-key mints a new vault key on a
 * device that has never seen the recovery key, so nothing could be wrapped
 * under the recovery key directly. Instead the recovery key's public half is
 * treated like one more device: every re-key seals the new vault key to it
 * (a "d1." envelope, ./device.ts, with the account in the seal's device id),
 * and only the recovery key can open the private half that unseals it.
 *
 * The server holds the public key, the wrapped private key ("r1." + iv +
 * AES-GCM, with the account id as associated data so one account's wrap
 * cannot stand in for another's), the sealed vault key, and the proof's
 * hash. None of these opens anything without the recovery key.
 *
 * The text form is "CSR1-" and 56 Crockford base32 characters in groups of
 * four: the 32 bytes and a 3-byte SHA-256 checksum, so a mistyped key is
 * caught before it is tried.
 */

import { fromBase64Url, toBase64Url } from "./base64";
import { createEcdhKeypair, CURVE } from "./ecdh";
import { openVaultKeyForDevice, sealVaultKeyForDevice } from "./device";

export const RECOVERY_KEY_PREFIX = "CSR1";
export const RECOVERY_WRAP_PREFIX = "r1";

const SECRET_BYTES = 32;
const CHECK_BYTES = 3;
const IV_BYTES = 12;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class RecoveryKeyError extends Error {}

/** What the server keeps for an account's recovery key. All of it is safe to store. */
export interface RecoveryMaterial {
  /** P-256 public key, raw, base64url. */
  publicKey: string;
  /** The private key (PKCS#8) wrapped under the recovery key: "r1.<iv>.<ct>". */
  wrappedPrivateKey: string;
  /** The vault key of `epoch`, sealed to `publicKey` ("d1."). */
  sealed: string;
  epoch: number;
  /** SHA-256 of the recovery proof, base64url. */
  recoveryHash: string;
}

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

async function checksum(secret: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", secret as Uint8Array<ArrayBuffer>);
  return new Uint8Array(digest).slice(0, CHECK_BYTES);
}

/** A fresh recovery key, as the owner writes it down. */
export async function generateRecoveryKey(): Promise<string> {
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const body = new Uint8Array(SECRET_BYTES + CHECK_BYTES);
  body.set(secret);
  body.set(await checksum(secret), SECRET_BYTES);
  const groups = base32(body).match(/.{1,4}/g) ?? [];
  return [RECOVERY_KEY_PREFIX, ...groups].join("-");
}

/**
 * The 32 bytes behind a recovery key as typed: any case, any spacing or
 * dashes, and the letters people misread as digits (O, I, L) taken as them.
 */
export async function parseRecoveryKey(text: string): Promise<Uint8Array<ArrayBuffer>> {
  let normal = text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  // The prefix is optional; with it, the key is exactly 4 characters longer.
  if (normal.length === RECOVERY_KEY_PREFIX.length + 56 && normal.startsWith(RECOVERY_KEY_PREFIX)) {
    normal = normal.slice(RECOVERY_KEY_PREFIX.length);
  }
  const bytes = unbase32(normal);
  if (!bytes || bytes.length !== SECRET_BYTES + CHECK_BYTES) {
    throw new RecoveryKeyError("that is not a recovery key (it should start CSR1- and have 14 groups of 4)");
  }
  const secret = bytes.slice(0, SECRET_BYTES);
  const expected = await checksum(secret);
  if (!expected.every((b, i) => b === bytes[SECRET_BYTES + i])) {
    throw new RecoveryKeyError("that recovery key has a typo in it -- check each group");
  }
  return secret;
}

async function derived(secret: Uint8Array<ArrayBuffer>) {
  const source = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: new TextEncoder().encode(info),
  });
  const [kek, proofBits] = await Promise.all([
    crypto.subtle.deriveKey(params("clipsync:recovery-kek:v1"), source, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.deriveBits(params("clipsync:recovery-auth:v1"), source, 256),
  ]);
  return { kek, proof: toBase64Url(new Uint8Array(proofBits)) };
}

/** The proof the server checks a recovery against (it keeps only its SHA-256). */
export async function recoveryProofOf(recoveryKey: string): Promise<string> {
  return (await derived(await parseRecoveryKey(recoveryKey))).proof;
}

const wrapAad = (account: string) => new TextEncoder().encode(`clipsync:recovery:v1:${account}`);

/** The device id a recovery seal is bound to: the account's, never a real device's. */
const sealId = (account: string) => `recovery:${account}`;

/** Seal `vaultKey` (of `epoch`) to an account's recovery key. What a re-key does for it. */
export function sealForRecovery(publicKey: string, account: string, epoch: number, vaultKey: string): Promise<string> {
  return sealVaultKeyForDevice({ deviceId: sealId(account), publicKey }, epoch, vaultKey);
}

/** Everything the server needs to keep for a new recovery key, given the current vault key. */
export async function createRecovery(
  recoveryKey: string,
  account: string,
  vaultKey: string,
  epoch: number,
): Promise<RecoveryMaterial> {
  const { kek, proof } = await derived(await parseRecoveryKey(recoveryKey));
  const keypair = await createEcdhKeypair(true);
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", keypair.privateKey)) as ArrayBuffer;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: wrapAad(account) }, kek, pkcs8);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return {
    publicKey: keypair.publicKey,
    wrappedPrivateKey: [RECOVERY_WRAP_PREFIX, toBase64Url(iv), toBase64Url(new Uint8Array(ct))].join("."),
    sealed: await sealForRecovery(keypair.publicKey, account, epoch, vaultKey),
    epoch,
    recoveryHash: toBase64Url(new Uint8Array(digest)),
  };
}

/** The vault key of `material.epoch`, opened with the recovery key. */
export async function openRecovery(
  recoveryKey: string,
  account: string,
  material: Pick<RecoveryMaterial, "publicKey" | "wrappedPrivateKey" | "sealed" | "epoch">,
): Promise<string> {
  const { kek } = await derived(await parseRecoveryKey(recoveryKey));
  const parts = material.wrappedPrivateKey.split(".");
  if (parts.length !== 3 || parts[0] !== RECOVERY_WRAP_PREFIX) {
    throw new RecoveryKeyError("the server's recovery data is not in a format this client reads");
  }
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[1]!), additionalData: wrapAad(account) },
      kek,
      fromBase64Url(parts[2]!),
    );
  } catch {
    throw new RecoveryKeyError("that recovery key does not open this account");
  }
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: CURVE }, false, ["deriveBits"]);
  return openVaultKeyForDevice({ privateKey, publicKey: material.publicKey }, sealId(account), material.epoch, material.sealed);
}
