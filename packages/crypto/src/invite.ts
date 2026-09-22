/**
 * Scan-to-join invites.
 *
 * For a phone, the QR goes the opposite direction from device linking: the
 * set-up machine displays it and the phone's camera reads it. That reverses
 * who needs a camera -- phones have one, desktops usually do not -- and it
 * makes the crypto simpler than the ECDH handshake in ./link.ts.
 *
 * Because the QR itself can carry a secret, there is no need to agree on one:
 *
 *   set-up device                server                    phone
 *   -------------                ------                    -----
 *   S = 32 random bytes
 *   sealed = AES-GCM(HKDF(S), vaultKey)
 *   store sealed, SHA-256(S) -->  keeps both
 *   show QR containing S  ....... camera ...............>   reads S
 *                                 sealed  <-- claim(SHA-256(S))
 *                                                          opens with S
 *
 * The server holds a ciphertext and a hash. S reaches the phone only through
 * the camera, so there is no relay to attack and nothing for a human to
 * compare.
 *
 * The trade is that the QR *is* the credential for its lifetime: anyone who
 * photographs it before it expires or is claimed can enrol. Invites are
 * therefore short-lived and single-use.
 */

import { fromBase64Url, toBase64Url } from "./base64";

export const INVITE_PREFIX = "i1";

const IV_BYTES = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The secret carried by the QR. Never sent to the server. */
export function generateInviteSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function inviteKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("clipsync:invite:v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealInvite(
  secret: string,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await inviteKey(secret),
    enc.encode(plaintext),
  );
  return `${INVITE_PREFIX}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export class InviteError extends Error {}

export async function openInvite(
  secret: string,
  envelope: string,
): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== INVITE_PREFIX) {
    throw new InviteError("unsupported invite envelope");
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[1]!) },
      await inviteKey(secret),
      fromBase64Url(parts[2]!),
    );
    return dec.decode(pt);
  } catch {
    throw new InviteError("this invite does not open with that secret");
  }
}

/**
 * Proves the claimer holds S without revealing it.
 *
 * Without this, knowing only the invite id would be enough to claim a device
 * token -- not enough to read any clip, but enough to enrol and to push. S has
 * 256 bits of entropy, so the hash is not brute-forcible, and it is derived
 * differently from the sealing key so learning it tells the server nothing.
 */
export async function inviteProof(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    fromBase64Url(secret),
  );
  return toBase64Url(new Uint8Array(digest));
}
