/** Identifier, token and secret helpers. All randomness is CSPRNG. */

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // Crockford-ish, no 0/O/1/I

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Prefixed, sortable-enough opaque id, e.g. `clip_9f3a...`. */
export function newId(prefix: string): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** 256-bit bearer token. Shown to the caller exactly once. */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Human-typeable pairing code, `PAIR-XXXX-XXXX`. ~50 bits of entropy over a
 * 10-minute window, and single-use.
 */
export function newPairCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += ALPHABET[raw[i]! % ALPHABET.length];
  }
  return `PAIR-${out}`;
}

/** Normalise user-typed codes: trim, upcase, tolerate a missing prefix. */
export function normalisePairCode(input: string): string {
  const s = input.trim().toUpperCase().replace(/\s+/g, "");
  return s.startsWith("PAIR-") ? s : `PAIR-${s}`;
}

/** SHA-256, base64url. Used to store tokens and codes at rest. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64url(new Uint8Array(digest));
}

/**
 * Constant-time string comparison for secrets that are compared directly
 * (the admin secret). Token lookups go through a hashed index instead.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
