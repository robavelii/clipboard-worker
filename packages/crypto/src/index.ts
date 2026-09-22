/**
 * Client-side envelope encryption for ClipSync.
 *
 * Runs unchanged in the browser, in Node >= 20 and in Workers: WebCrypto only,
 * no platform imports. The Worker imports this module for *nothing but* types --
 * it never holds a key.
 *
 * Key hierarchy:
 *
 *   passphrase --PBKDF2(salt, 600k)--> master
 *                                       |--HKDF("enc")-----> AES-GCM-256 key
 *                                       `--HKDF("dedupe")--> HMAC-SHA256 key
 *
 * The salt is public (stored server-side, handed out at pair time). The
 * passphrase never leaves the device.
 */

export const PBKDF2_ITERATIONS = 600_000;
export const ENVELOPE_PREFIX = "v1";

const IV_BYTES = 12;
const SALT_BYTES = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface VaultKeys {
  /** AES-GCM-256, encrypts clipboard payloads. */
  readonly enc: CryptoKey;
  /** HMAC-SHA256, produces server-visible dedupe tags. */
  readonly dedupe: CryptoKey;
}

/* ------------------------------ base64url ------------------------------ */

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns Uint8Array<ArrayBuffer> rather than the default ArrayBufferLike so
// the result satisfies BufferSource under the DOM lib as well as Workers.
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fresh per-user KDF salt. Public value -- safe to store and transmit. */
export function randomSalt(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/* -------------------------------- keys --------------------------------- */

/**
 * Derive the vault keys. Intentionally slow (~0.5s) -- call once per session
 * and keep the result in memory.
 */
export async function deriveKeys(
  passphrase: string,
  saltB64: string,
): Promise<VaultKeys> {
  const salt = fromBase64Url(saltB64);

  const pw = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const masterBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    pw,
    256,
  );

  const master = await crypto.subtle.importKey(
    "raw",
    masterBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const hkdfParams = (info: string) =>
    ({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }) as const;

  // Inlined rather than factored into a helper: DOM, Workers and Node each
  // name the WebCrypto algorithm parameter types differently, and only literal
  // arguments type-check against all three.
  const [encKey, dedupeKey] = await Promise.all([
    crypto.subtle.deriveKey(
      hkdfParams("clipsync:enc:v1"),
      master,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ),
    crypto.subtle.deriveKey(
      hkdfParams("clipsync:dedupe:v1"),
      master,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  ]);

  return { enc: encKey, dedupe: dedupeKey };
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

export class DecryptError extends Error {}

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
