/**
 * Browser-side session state.
 *
 * Two separate stores on purpose:
 *   - credentials in localStorage, so the browser stays a paired device;
 *   - the passphrase in sessionStorage, so closing the tab drops the key.
 * The passphrase is never written to localStorage and never sent anywhere.
 */

import type { Credentials } from "@clipsync/protocol";
import { deriveKeys, type VaultKeys } from "@clipsync/crypto";

const CREDS_KEY = "clipsync.credentials";
const PASS_KEY = "clipsync.passphrase";

export function loadCredentials(): Credentials | null {
  const raw = localStorage.getItem(CREDS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Credentials;
  } catch {
    localStorage.removeItem(CREDS_KEY);
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export function clearSession(): void {
  localStorage.removeItem(CREDS_KEY);
  sessionStorage.removeItem(PASS_KEY);
}

export function cachedPassphrase(): string | null {
  return sessionStorage.getItem(PASS_KEY);
}

export function cachePassphrase(passphrase: string): void {
  sessionStorage.setItem(PASS_KEY, passphrase);
}

export function forgetPassphrase(): void {
  sessionStorage.removeItem(PASS_KEY);
}

export async function unlock(
  passphrase: string,
  kdfSalt: string,
): Promise<VaultKeys> {
  return deriveKeys(passphrase, kdfSalt);
}
