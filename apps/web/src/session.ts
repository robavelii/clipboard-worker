/**
 * Browser-side session state.
 *
 * Two separate stores on purpose:
 *   - credentials in localStorage, so the browser stays a paired device;
 *   - the passphrase in sessionStorage, so closing the tab drops the key.
 * The passphrase is never written to localStorage and never sent anywhere.
 */

import type { Credentials } from "@clipsync/protocol";
import { vaultKeysFrom, type VaultKey, type VaultKeys } from "@clipsync/crypto";
import { unlockVault } from "@clipsync/client/vault";
import type { ApiClient } from "@clipsync/client";

const CREDS_KEY = "clipsync.credentials";
/**
 * The vault key, not the passphrase, and in sessionStorage rather than
 * localStorage: closing the tab drops it. Neither is ever sent anywhere.
 */
const VAULT_KEY = "clipsync.vaultKey";

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
  sessionStorage.removeItem(VAULT_KEY);
}

export function cachedVaultKey(): VaultKey | null {
  return sessionStorage.getItem(VAULT_KEY);
}

export function cacheVaultKey(vaultKey: VaultKey): void {
  sessionStorage.setItem(VAULT_KEY, vaultKey);
}

export function forgetVaultKey(): void {
  sessionStorage.removeItem(VAULT_KEY);
}

/** Cheap: no PBKDF2, just HKDF off a key already in hand. */
export async function keysFor(
  vaultKey: VaultKey,
  kdfSalt: string,
): Promise<VaultKeys> {
  return vaultKeysFrom(vaultKey, kdfSalt);
}

/** Expensive: runs PBKDF2, then unwraps or migrates the vault key. */
export async function unlockWithPassphrase(
  api: ApiClient,
  passphrase: string,
  kdfSalt: string,
  wrappedVaultKey: string | null,
): Promise<VaultKey> {
  const { vaultKey } = await unlockVault(api, passphrase, kdfSalt, wrappedVaultKey);
  cacheVaultKey(vaultKey);
  return vaultKey;
}
