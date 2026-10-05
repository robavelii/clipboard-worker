/**
 * Accounts beyond the first (decisions §45), the same flow on every surface:
 * the CLI, the web UI and the tray call these rather than the routes.
 *
 * Signup makes the account and this device, then creates the vault exactly
 * as bootstrap's first device does: a random vault key, wrapped under the
 * passphrase, never sent in the clear. Sign-in proves the passphrase to an
 * existing account (its `authProof`, never the passphrase) and unlocks the
 * vault key the server returns with the new device's credentials.
 */

import type { Credentials, Platform } from "@clipsync/protocol";
import { openVault, type VaultKey } from "@clipsync/crypto";
import { ApiClient } from "./index";
import { unlockVault } from "./vault";

export interface Enrolled {
  credentials: Credentials;
  vaultKey: VaultKey;
  /** As from unlockVault: the account already proves a different passphrase. */
  proofConflict: boolean;
}

interface Common {
  baseUrl: string;
  email: string;
  passphrase: string;
  deviceName: string;
  platform: Platform;
  fetchImpl?: typeof fetch;
}

/** Ask the server to mail a signup code to `email`. */
export function requestSignupCode(baseUrl: string, email: string, fetchImpl?: typeof fetch): Promise<unknown> {
  return new ApiClient(baseUrl, undefined, fetchImpl).signupEmail(email);
}

/** Make an account with a mailed `code` or an admin's `invite`, and this device in it. */
export async function signUp(opts: Common & { code?: string; invite?: string }): Promise<Enrolled> {
  const credentials = await new ApiClient(opts.baseUrl, undefined, opts.fetchImpl).signup({
    email: opts.email,
    code: opts.code,
    invite: opts.invite,
    deviceName: opts.deviceName,
    platform: opts.platform,
  });
  const api = new ApiClient(opts.baseUrl, credentials.token, opts.fetchImpl);
  // A new account: a fresh random vault key. Without `true`, unlockVault
  // would take a missing key for a legacy account's.
  const { vaultKey, proofConflict } = await unlockVault(api, opts.passphrase, credentials.kdfSalt, null, true);
  return { credentials, vaultKey, proofConflict };
}

/** Enrol this device into the account at `email`, given its passphrase. */
export async function signIn(opts: Common): Promise<Enrolled> {
  const anonymous = new ApiClient(opts.baseUrl, undefined, opts.fetchImpl);
  const { kdfSalt } = await anonymous.signinSalt(opts.email);
  const { authProof } = await openVault(opts.passphrase, kdfSalt);
  const credentials = await anonymous.signin({
    email: opts.email,
    authProof,
    deviceName: opts.deviceName,
    platform: opts.platform,
  });
  const api = new ApiClient(opts.baseUrl, credentials.token, opts.fetchImpl);
  try {
    const { vaultKey, proofConflict } = await unlockVault(api, opts.passphrase, credentials.kdfSalt, credentials.wrappedVaultKey);
    return { credentials, vaultKey, proofConflict };
  } catch (err) {
    // The proof matched, so this should not happen; leave no device behind if it does.
    await api.revokeSelf().catch(() => undefined);
    throw err;
  }
}
