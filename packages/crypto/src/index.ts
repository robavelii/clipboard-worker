/**
 * Client-side envelope encryption for ClipSync.
 *
 * Runs unchanged in the browser, in Node >= 20 and in Workers: WebCrypto only,
 * no platform imports. The Worker imports this module for *nothing but* types --
 * it never holds a key.
 *
 * Key hierarchy:
 *
 *   passphrase --PBKDF2(salt, 600k)--> master --HKDF("kek")--> KEK
 *                                                                |
 *                                                     unwraps    v
 *   vault key (32 random bytes) <------------- wrapped vault key (server-held)
 *        |--HKDF("enc")-----> AES-GCM-256 key
 *        `--HKDF("dedupe")--> HMAC-SHA256 key
 *
 * The vault key, not the passphrase, is what actually protects clips. The
 * passphrase only unlocks it. That indirection buys two things:
 *
 *   - changing the passphrase re-wraps 32 bytes instead of re-encrypting
 *     every clip ever stored;
 *   - a device linked by QR receives the vault key alone, so it can read the
 *     clipboard without ever learning the passphrase that guards it.
 *
 * Accounts created before the vault key existed derived the content keys
 * straight from `master`. For those, the vault key *is* `master` -- see
 * {@link openVault} -- so migrating re-wraps 32 bytes and leaves every
 * existing clip decryptable, bit for bit.
 *
 * The salt is public (stored server-side, handed out at pair time). The
 * passphrase never leaves the device.
 */

export const PBKDF2_ITERATIONS = 600_000;
export const ENVELOPE_PREFIX = "v1";
export const WRAPPED_KEY_PREFIX = "k1";

const IV_BYTES = 12;
const SALT_BYTES = 16;

import { fromBase64Url, toBase64Url } from "./base64";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface VaultKeys {
  /** AES-GCM-256, encrypts clipboard payloads. */
  readonly enc: CryptoKey;
  /** HMAC-SHA256, produces server-visible dedupe tags. */
  readonly dedupe: CryptoKey;
}

export { fromBase64Url, toBase64Url } from "./base64";

/** Fresh per-user KDF salt. Public value -- safe to store and transmit. */
export function randomSalt(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/* -------------------------------- keys --------------------------------- */

export class DecryptError extends Error {}

/** 32 bytes of key material, base64url. Never sent to the server unwrapped. */
export type VaultKey = string;

/** A fresh vault key for a brand-new account. */
export function generateVaultKey(): VaultKey {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function pbkdf2Master(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const pw = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    pw,
    256,
  );
}

async function hkdfSource(bits: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
}

function hkdfParams(salt: Uint8Array<ArrayBuffer>, info: string) {
  return { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) } as const;
}

export interface OpenedVault {
  /** Wraps and unwraps the vault key. Never touches clip content. */
  readonly kek: CryptoKey;
  /**
   * What the vault key is for an account that predates wrapping. Using it
   * keeps every previously stored clip decryptable.
   */
  readonly legacyVaultKey: VaultKey;
}

/**
 * Turn a passphrase into the key-encryption key.
 *
 * Intentionally slow (~0.5s). Runs PBKDF2 once and returns both products, so
 * callers never pay for it twice.
 */
export async function openVault(
  passphrase: string,
  saltB64: string,
): Promise<OpenedVault> {
  const salt = fromBase64Url(saltB64);
  const masterBits = await pbkdf2Master(passphrase, salt);
  const master = await hkdfSource(masterBits);

  const kek = await crypto.subtle.deriveKey(
    hkdfParams(salt, "clipsync:kek:v1"),
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    kek,
    legacyVaultKey: toBase64Url(new Uint8Array(masterBits)),
  };
}

/** Seal the vault key for storage on the server. */
export async function wrapVaultKey(
  kek: CryptoKey,
  vaultKey: VaultKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    fromBase64Url(vaultKey),
  );
  return `${WRAPPED_KEY_PREFIX}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function unwrapVaultKey(
  kek: CryptoKey,
  wrapped: string,
): Promise<VaultKey> {
  const parts = wrapped.split(".");
  if (parts.length !== 3 || parts[0] !== WRAPPED_KEY_PREFIX) {
    throw new DecryptError("unsupported wrapped-key format");
  }
  try {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[1]!) },
      kek,
      fromBase64Url(parts[2]!),
    );
    return toBase64Url(new Uint8Array(raw));
  } catch {
    throw new DecryptError("wrong passphrase");
  }
}

/** The keys that actually encrypt clips. Cheap -- no PBKDF2 here. */
export async function vaultKeysFrom(
  vaultKey: VaultKey,
  saltB64: string,
): Promise<VaultKeys> {
  const salt = fromBase64Url(saltB64);
  const source = await hkdfSource(fromBase64Url(vaultKey).buffer);

  const [encKey, dedupeKey] = await Promise.all([
    crypto.subtle.deriveKey(
      hkdfParams(salt, "clipsync:enc:v1"),
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      hkdfParams(salt, "clipsync:dedupe:v1"),
      source,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  ]);

  return { enc: encKey, dedupe: dedupeKey };
}

/**
 * Passphrase straight to content keys, the pre-vault-key derivation.
 *
 * Retained because it defines what a migrated account's vault key has to be:
 * `openVault().legacyVaultKey` fed through {@link vaultKeysFrom} reproduces
 * exactly these keys.
 */
export async function deriveKeys(
  passphrase: string,
  saltB64: string,
): Promise<VaultKeys> {
  const { legacyVaultKey } = await openVault(passphrase, saltB64);
  return vaultKeysFrom(legacyVaultKey, saltB64);
}

/* ----------------------------- envelopes ------------------------------- */

/** Encrypt UTF-8 text into `v1.<iv>.<ciphertext>`. */
export async function encryptText(
  keys: VaultKeys,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keys.enc,
    enc.encode(plaintext),
  );
  return `${ENVELOPE_PREFIX}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/**
 * Reverse of {@link encryptText}. Throws {@link DecryptError} on a malformed
 * envelope or a wrong passphrase -- the two are indistinguishable by design.
 */
export async function decryptText(
  keys: VaultKeys,
  envelope: string,
): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) {
    throw new DecryptError(`unsupported envelope format`);
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[1]!) },
      keys.enc,
      fromBase64Url(parts[2]!),
    );
    return dec.decode(pt);
  } catch {
    throw new DecryptError("cannot decrypt -- wrong passphrase or corrupt data");
  }
}

/**
 * Server-visible dedupe tag. An HMAC rather than a plain digest so that nobody
 * holding the database can confirm a guess at the clipboard contents.
 */
export async function dedupeHash(
  keys: VaultKeys,
  plaintext: string,
): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    keys.dedupe,
    enc.encode(plaintext),
  );
  return toBase64Url(new Uint8Array(mac));
}

/** Cheap self-check that a passphrase matches an existing clip. */
export async function verifyKeys(
  keys: VaultKeys,
  sampleEnvelope: string,
): Promise<boolean> {
  try {
    await decryptText(keys, sampleEnvelope);
    return true;
  } catch {
    return false;
  }
}

export * from "./link";
