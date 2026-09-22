/** On-disk agent state: `~/.config/clipsync/config.json`, mode 0600. */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ApiClient } from "@clipsync/client";
import { unlockVault } from "@clipsync/client/vault";
import { vaultKeysFrom, type VaultKeys } from "@clipsync/crypto";
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
   * The vault key, not the passphrase.
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
   */
  vaultKey?: string;
  /**
   * Written by versions that stored the passphrase instead of the vault key.
   * {@link resolveVaultKeys} upgrades such a config in place on first run and
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

/**
 * Resolve the keys that encrypt clips.
 *
 * Prefers the stored vault key. Falls back to CLIPSYNC_PASSPHRASE, which costs
 * one PBKDF2 at startup and a round trip to fetch the wrapped key.
 */
export async function resolveVaultKeys(
  config: AgentConfig,
  api: ApiClient,
): Promise<VaultKeys> {
  if (config.vaultKey) {
    return vaultKeysFrom(config.vaultKey, config.kdfSalt);
  }
  const vaultKey = await resolveVaultKey(config, api);
  return vaultKeysFrom(vaultKey, config.kdfSalt);
}

/**
 * The raw vault key, needed to re-wrap it under a new passphrase.
 *
 * Also the upgrade path: a config written before the vault key existed holds
 * a passphrase, which is enough to derive or unwrap the key. When that
 * happens the config is rewritten to hold the key instead, so the cost is
 * paid exactly once.
 */
export async function resolveVaultKey(
  config: AgentConfig,
  api: ApiClient,
): Promise<string> {
  if (config.vaultKey) return config.vaultKey;

  const passphrase = process.env.CLIPSYNC_PASSPHRASE ?? config.passphrase;
  if (!passphrase) {
    throw new Error(
      "no vault key available -- set CLIPSYNC_PASSPHRASE or re-run `clipsync login`",
    );
  }

  const { kdfSalt, wrappedVaultKey } = await api.vaultKey();
  const { vaultKey } = await unlockVault(api, passphrase, kdfSalt, wrappedVaultKey);

  if (config.passphrase) {
    const { passphrase: _dropped, ...rest } = config;
    await saveConfig({ ...rest, vaultKey });
  }

  return vaultKey;
}
