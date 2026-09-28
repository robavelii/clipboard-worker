/**
 * Unlocking, migrating and rotating the vault.
 *
 * Shared by the agent and the web UI so the migration rule -- what the vault
 * key must be for an account that predates wrapping -- exists in exactly one
 * place. Getting it wrong there makes every historical clip unreadable.
 */

import {
  authHashOf,
  generateVaultKey,
  openVault,
  unwrapVaultKey,
  wrapVaultKey,
  type OpenedVault,
  type VaultKey,
} from "@clipsync/crypto";
import { ApiRequestError, type ApiClient } from "./index";

export interface UnlockedVault {
  vaultKey: VaultKey;
  /** True when this call wrote the wrapped key for the first time. */
  migrated: boolean;
  /**
   * True when the server already holds proof of a *different* passphrase.
   * The account predates passphrase proofs and another device registered one
   * first, so that device, not this passphrase, now controls rotation.
   */
  proofConflict: boolean;
}

/**
 * Register this passphrase's proof, for accounts from before proofs existed.
 *
 * Runs on every passphrase unlock: first use wins, so claiming promptly is
 * what closes the window. Best effort -- an older Worker without the route,
 * or a network blip, must not stop anyone reading their clipboard -- except
 * that a conflict is reported, because it means someone else got there first.
 */
async function registerProof(
  api: ApiClient,
  opened: OpenedVault,
): Promise<boolean> {
  try {
    await api.claimVaultAuth(await authHashOf(opened.authProof));
    return false;
  } catch (err) {
    return err instanceof ApiRequestError && err.status === 409;
  }
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

  const fromWrapped = async (wrapped: string): Promise<UnlockedVault> => ({
    vaultKey: await unwrapVaultKey(opened.kek, wrapped),
    migrated: false,
    proofConflict: await registerProof(api, opened),
  });

  if (wrappedVaultKey) return fromWrapped(wrappedVaultKey);

  const vaultKey = isNewAccount ? generateVaultKey() : opened.legacyVaultKey;
  try {
    await api.putVaultKey({
      wrappedVaultKey: await wrapVaultKey(opened.kek, vaultKey),
      authHash: await authHashOf(opened.authProof),
    });
  } catch (err) {
    // Another device wrapped it between our read and our write. Theirs is
    // the key now; a first write never replaces one.
    if (!(err instanceof ApiRequestError && err.status === 403)) throw err;
    const current = await api.vaultKey();
    if (!current.wrappedVaultKey) throw err;
    return fromWrapped(current.wrappedVaultKey);
  }
  return { vaultKey, migrated: true, proofConflict: false };
}

/**
 * Change the passphrase.
 *
 * Re-wraps the vault key and touches nothing else, so no clip is re-encrypted
 * and no other device needs to do anything -- they all hold the vault key
 * already.
 *
 * Needs the current passphrase: the server replaces the wrapped key only with
 * its proof, so a device that holds the vault key but was never told the
 * passphrase cannot change it. A wrong current passphrase fails here, before
 * anything is sent.
 */
export async function changePassphrase(
  api: ApiClient,
  kdfSalt: string,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  const { wrappedVaultKey, keyEpoch } = await api.vaultKey();
  if (!wrappedVaultKey) {
    throw new Error("this account has no wrapped vault key yet -- unlock it once first");
  }

  const current = await openVault(currentPassphrase, kdfSalt);
  const vaultKey = await unwrapVaultKey(current.kek, wrappedVaultKey);

  if (await registerProof(api, current)) {
    throw new Error(
      "another device registered a different passphrase for this account -- " +
        "it controls passphrase changes until the vault is re-keyed",
    );
  }

  const next = await openVault(newPassphrase, kdfSalt);
  await api.putVaultKey({
    wrappedVaultKey: await wrapVaultKey(next.kek, vaultKey),
    authHash: await authHashOf(next.authProof),
    authProof: current.authProof,
    keyEpoch,
  });
}
