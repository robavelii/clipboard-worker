/**
 * The recovery key (decisions §48), as every surface uses it: the CLI, the
 * web UI and the tray call these rather than the routes.
 *
 * Making one needs the passphrase: the server takes it only with the
 * passphrase's proof, and the passphrase is also checked here, locally,
 * against the vault key this device holds, so a recovery key is never made
 * for a key the passphrase doesn't open.
 *
 * Recovering needs only the address and the recovery key. It opens the
 * vault key, wraps it under a new passphrase and enrols this device. The
 * vault key is unchanged, so every other device keeps working and every
 * clip stays readable.
 */

import {
  authHashOf,
  createRecovery,
  generateRecoveryKey,
  openRecovery,
  openVault,
  recoveryProofOf,
  unwrapVaultKey,
  wrapVaultKey,
  type VaultKey,
} from "@clipsync/crypto";
import type { Credentials, Platform } from "@clipsync/protocol";
import { ApiClient, ApiRequestError } from "./index";

/**
 * Make a recovery key for the account `api`'s device is in, replacing any it
 * had. Returns it, to show the owner once: it is not stored anywhere.
 */
export async function setUpRecovery(
  api: ApiClient,
  opts: { account: string; passphrase: string; kdfSalt: string; vaultKey: VaultKey },
): Promise<string> {
  const { wrappedVaultKey, keyEpoch } = await api.vaultKey();
  if (!wrappedVaultKey) throw new Error("this account has no wrapped vault key yet -- unlock it once first");
  const opened = await openVault(opts.passphrase, opts.kdfSalt);
  // A wrong passphrase fails here (DecryptError), before anything is sent.
  if ((await unwrapVaultKey(opened.kek, wrappedVaultKey)) !== opts.vaultKey) {
    throw new Error("the passphrase opens a different vault key than this device holds -- restart it to pick up a re-key first");
  }
  const recoveryKey = await generateRecoveryKey();
  const material = await createRecovery(recoveryKey, opts.account, opts.vaultKey, keyEpoch);
  await api.setRecovery({ authProof: opened.authProof, ...material });
  return recoveryKey;
}

/**
 * The recovery key's public key, for a re-key to seal the new vault key to;
 * null when the account has none (or the server predates recovery keys).
 */
export async function recoveryPublicKey(api: ApiClient): Promise<string | null> {
  try {
    return (await api.recoveryStatus()).publicKey;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

export interface Recovered {
  credentials: Credentials;
  vaultKey: VaultKey;
}

/** Reset the passphrase of the account at `email` with its recovery key, and enrol this device. */
export async function recoverAccount(opts: {
  baseUrl: string;
  email: string;
  recoveryKey: string;
  newPassphrase: string;
  deviceName: string;
  platform: Platform;
  /** Sign every other device out: the lost ones. */
  revokeOtherDevices?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<Recovered> {
  const api = new ApiClient(opts.baseUrl, undefined, opts.fetchImpl);
  // A mistyped key fails here, on its checksum, before anything is sent.
  const recoveryProof = await recoveryProofOf(opts.recoveryKey);
  const found = await api.recoveryOpen({ email: opts.email, recoveryProof });
  const vaultKey = await openRecovery(opts.recoveryKey, found.userId, found);

  const next = await openVault(opts.newPassphrase, found.kdfSalt);
  const credentials = await api.recoveryReset({
    email: opts.email,
    recoveryProof,
    wrappedVaultKey: await wrapVaultKey(next.kek, vaultKey),
    authHash: await authHashOf(next.authProof),
    keyEpoch: found.keyEpoch,
    deviceName: opts.deviceName,
    platform: opts.platform,
    revokeOtherDevices: opts.revokeOtherDevices ?? false,
  });
  return { credentials, vaultKey };
}
