/** On-disk agent state: `~/.config/clipsync/config.json`, mode 0600. */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ApiClient } from "@clipsync/client";
import { registerDeviceKey, refreshVaultRing } from "@clipsync/client/rekey";
import {
  currentKey,
  ringOf,
  withKey,
  type VaultRing,
} from "@clipsync/client/ring";
import { unlockVault } from "@clipsync/client/vault";
import {
  exportDeviceKeypair,
  generateDeviceKeypair,
  importDeviceKeypair,
  type DeviceKeypair,
  type StoredDeviceKeypair,
} from "@clipsync/crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentConfig {
  baseUrl: string;
  userId: string;
  deviceId: string;
  deviceName: string;
  token: string;
  kdfSalt: string;
  /**
   * The current vault key, not the passphrase.
   *
   * Stored so the agent can start unattended. End-to-end encryption defends
   * against a compromise of the *server*; a key in a 0600 file on a machine
   * that already holds the decrypted clipboard adds nothing to the local
   * threat model.
   *
   * Holding the key rather than the passphrase also means a device linked by
   * QR can read the clipboard without ever learning the passphrase, and that
   * changing the passphrase does not require touching this file.
   *
   * Set CLIPSYNC_PASSPHRASE instead to keep nothing on disk; the agent then
   * unwraps the key from the server at startup.
   *
   * Kept equal to the current entry of `vaultKeys`, which older tray builds
   * read.
   */
  vaultKey?: string;
  /** Every vault key this device holds, by epoch. See @clipsync/client/ring. */
  vaultKeys?: Record<string, string>;
  /** The epoch new clips are written under. */
  keyEpoch?: number;
  /**
   * This device's long-term keypair; a re-key seals the new vault key to its
   * public half. Not kept in CLIPSYNC_PASSPHRASE mode, which stores no key
   * material and picks up a re-key through the passphrase instead.
   */
  deviceKey?: StoredDeviceKeypair;
  /**
   * Written by versions that stored the passphrase instead of the vault key.
   * {@link resolveVaultRing} upgrades such a config in place on first run and
   * clears this field, so an agent that is already running keeps working
   * across the upgrade without anyone re-enrolling.
   */
  passphrase?: string;
}

export function configDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "clipsync");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function requireConfig(): Promise<AgentConfig> {
  const cfg = await loadConfig();
  if (!cfg) {
    throw new Error(
      "not configured -- run `clipsync login` or `clipsync pair <code>` first",
    );
  }
  return cfg;
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600); // Explicit: mode is ignored if the file existed.
}

export async function clearConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

/** The ring stored in this config, or null in CLIPSYNC_PASSPHRASE mode. */
export function storedRing(config: AgentConfig): VaultRing | null {
  if (config.vaultKeys && Object.keys(config.vaultKeys).length) {
    return { current: config.keyEpoch ?? 0, keys: config.vaultKeys };
  }
  if (config.vaultKey) return ringOf(config.vaultKey, config.keyEpoch ?? 0);
  return null;
}

/** `config` holding `ring`, with `vaultKey` kept as the current key. */
export function withRing(config: AgentConfig, ring: VaultRing): AgentConfig {
  return {
    ...config,
    vaultKeys: ring.keys,
    keyEpoch: ring.current,
    vaultKey: currentKey(ring),
  };
}

function passphraseFor(config: AgentConfig): string | undefined {
  return process.env.CLIPSYNC_PASSPHRASE ?? config.passphrase;
}

/** The current key only: the passphrase unwraps nothing older. */
async function ringFromPassphrase(
  api: ApiClient,
  passphrase: string,
): Promise<VaultRing> {
  const { kdfSalt, wrappedVaultKey, keyEpoch } = await api.vaultKey();
  const { vaultKey } = await unlockVault(api, passphrase, kdfSalt, wrappedVaultKey);
  return ringOf(vaultKey, keyEpoch);
}

/**
 * The vault keys this device holds.
 *
 * Prefers the stored ring. Falls back to CLIPSYNC_PASSPHRASE, which costs one
 * PBKDF2 at startup and a round trip to fetch the wrapped key. That is also
 * the upgrade path for a config written before the vault key existed: it
 * holds a passphrase, and is rewritten to hold the key instead, once.
 */
export async function resolveVaultRing(
  config: AgentConfig,
  api: ApiClient,
): Promise<VaultRing> {
  const stored = storedRing(config);
  if (stored) return stored;

  const passphrase = passphraseFor(config);
  if (!passphrase) {
    throw new Error(
      "no vault key available -- set CLIPSYNC_PASSPHRASE or re-run `clipsync login`",
    );
  }
  const ring = await ringFromPassphrase(api, passphrase);

  if (config.passphrase) {
    const { passphrase: _dropped, ...rest } = config;
    await saveConfig(withRing(rest, ring));
  }
  return ring;
}

/**
 * This device's keypair, created and saved on first use, and registered with
 * the Worker every time (it is idempotent, and a Worker older than device
 * keys just ignores it). null in CLIPSYNC_PASSPHRASE mode.
 */
export async function ensureDeviceKey(
  config: AgentConfig,
  api: ApiClient,
): Promise<{ config: AgentConfig; keypair: DeviceKeypair | null }> {
  if (!storedRing(config)) return { config, keypair: null };

  let next = config;
  if (!config.deviceKey) {
    next = {
      ...config,
      deviceKey: await exportDeviceKeypair(await generateDeviceKeypair(true)),
    };
    await saveConfig(next);
  }
  await registerDeviceKey(api, next.deviceKey!.publicKey);
  return { config: next, keypair: await importDeviceKeypair(next.deviceKey!) };
}

/**
 * Pick up a re-key this device has not seen yet -- its sealed copy, or in
 * CLIPSYNC_PASSPHRASE mode the passphrase -- saving the ring when it is
 * stored. Throws NoSealedKeyError when the re-key left this device out.
 */
export async function refreshRing(
  config: AgentConfig,
  api: ApiClient,
  keypair: DeviceKeypair | null,
  ring: VaultRing,
): Promise<{ config: AgentConfig; ring: VaultRing }> {
  if (!storedRing(config)) {
    const fresh = await ringFromPassphrase(api, passphraseFor(config) ?? "");
    return { config, ring: withKey(ring, fresh.current, currentKey(fresh)) };
  }
  const next = await refreshVaultRing(api, keypair, config.deviceId, ring);
  if (next === ring) return { config, ring };
  const updated = withRing(config, next);
  await saveConfig(updated);
  return { config: updated, ring: next };
}

/**
 * The ring as it stands on the server now: registers this device's key and
 * picks up any re-key it missed. For one-shot commands, which have no event
 * stream to hear about a re-key from -- and for anything that hands the
 * current key on, which must not hand on one the vault has moved past.
 */
export async function freshRing(
  config: AgentConfig,
  api: ApiClient,
): Promise<{ config: AgentConfig; ring: VaultRing }> {
  const ring = await resolveVaultRing(config, api);
  // Unwrapped from the passphrase just now: already the newest.
  if (!storedRing(config)) return { config, ring };
  const ensured = await ensureDeviceKey(config, api);
  return refreshRing(ensured.config, api, ensured.keypair, ring);
}
