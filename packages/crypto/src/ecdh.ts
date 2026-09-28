/**
 * ECDH over P-256, then HKDF to an AES-GCM key.
 *
 * Shared by device linking (./link.ts) and sealing the vault key to a
 * device's long-term key (./device.ts). Each caller supplies its own HKDF
 * info string, which is where both public keys and any other context get
 * bound, so a transcript with a swapped key derives a different key and the
 * open fails closed.
 */

import { fromBase64Url, toBase64Url } from "./base64";

export const CURVE = "P-256";

export interface EcdhKeypair {
  readonly privateKey: CryptoKey;
  /** Raw uncompressed point, base64url. Safe to publish. */
  readonly publicKey: string;
}

/**
 * A fresh keypair. `extractable` governs the private key only (a public key
 * can always be exported): true where it must be written to disk, false where
 * the platform can hold it, as IndexedDB can in a browser.
 */
export async function createEcdhKeypair(
  extractable: boolean,
): Promise<EcdhKeypair> {
  // Cast because the Workers type definitions declare the union return for
  // generateKey/exportKey rather than narrowing by algorithm the way the DOM
  // lib does. An ECDH generateKey always yields a pair, and a "raw" export is
  // always an ArrayBuffer.
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: CURVE },
    extractable,
    ["deriveBits"],
  )) as CryptoKeyPair;

  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  return {
    privateKey: pair.privateKey,
    publicKey: toBase64Url(new Uint8Array(raw)),
  };
}

export async function importEcdhPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64Url(publicKey),
    { name: "ECDH", namedCurve: CURVE },
    false,
    [],
  );
}

export async function ecdhAesKey(
  privateKey: CryptoKey,
  peerPublicKey: string,
  info: string,
): Promise<CryptoKey> {
  const peer = await importEcdhPublicKey(peerPublicKey);

  // The Workers type definitions name this field `$public` (a reserved word in
  // the IDL they generate from) while the DOM lib and the actual runtime both
  // use `public`. Setting both keeps this one file compiling against either.
  const ecdh = {
    name: "ECDH",
    public: peer,
    $public: peer,
  } as Parameters<typeof crypto.subtle.deriveBits>[0];

  const bits = await crypto.subtle.deriveBits(ecdh, privateKey, 256);

  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
