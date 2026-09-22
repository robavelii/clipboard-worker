/** On-disk agent state: `~/.config/clipsync/config.json`, mode 0600. */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
   * Stored so the agent can start unattended. End-to-end encryption defends
   * against a compromise of the *server*; a passphrase on a 0600 file on a
   * machine that already holds the decrypted clipboard adds nothing to the
   * local threat model. Set CLIPSYNC_PASSPHRASE to keep it out of the file.
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

/** Env wins over the config file so a headless run can avoid storing it. */
export function resolvePassphrase(config: AgentConfig): string {
  const pass = process.env.CLIPSYNC_PASSPHRASE ?? config.passphrase;
  if (!pass) {
    throw new Error(
      "no passphrase available -- set CLIPSYNC_PASSPHRASE or re-run `clipsync login`",
    );
  }
  return pass;
}
