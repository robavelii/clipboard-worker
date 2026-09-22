/**
 * Unlocking, migrating and rotating the vault.
 *
 * Shared by the agent and the web UI so the migration rule -- what the vault
 * key must be for an account that predates wrapping -- exists in exactly one
 * place. Getting it wrong there makes every historical clip unreadable.
 */

import {
  generateVaultKey,
  openVault,
  unwrapVaultKey,
  wrapVaultKey,
  type VaultKey,
} from "@clipsync/crypto";
import type { ApiClient } from "./index";

export interface UnlockedVault {
  vaultKey: VaultKey;
  /** True when this call wrote the wrapped key for the first time. */
  migrated: boolean;
}

/**
 * Turn a passphrase into the account's vault key, creating or migrating the
 * wrapped form if the server does not have one yet.
 *
 * Three cases:
 *   - already wrapped        unwrap it
 *   - brand-new account      mint a random vault key and wrap it
 *   - account predating this the vault key *is* the old PBKDF2 output, so
 *                            every clip already stored stays readable
 */
export async function unlockVault(
  api: ApiClient,
  passphrase: string,
  kdfSalt: string,
  wrappedVaultKey: string | null,
  isNewAccount = false,
): Promise<UnlockedVault> {
  const opened = await openVault(passphrase, kdfSalt);

  if (wrappedVaultKey) {
    return {
      vaultKey: await unwrapVaultKey(opened.kek, wrappedVaultKey),
      migrated: false,
    };
  }

  const vaultKey = isNewAccount
    ? generateVaultKey()
    : opened.legacyVaultKey;

  await api.putVaultKey(await wrapVaultKey(opened.kek, vaultKey));
  return { vaultKey, migrated: true };
}

/**
 * Change the passphrase.
 *
 * Re-wraps the vault key and touches nothing else, so no clip is re-encrypted
 * and no other device needs to do anything -- they all hold the vault key
 * already.
 */
export async function changePassphrase(
  api: ApiClient,
  vaultKey: VaultKey,
  kdfSalt: string,
  newPassphrase: string,
): Promise<void> {
  const next = await openVault(newPassphrase, kdfSalt);
  await api.putVaultKey(await wrapVaultKey(next.kek, vaultKey));
}
