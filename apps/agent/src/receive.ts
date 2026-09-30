/**
 * Receiving files on a desktop (decisions §37): where another device's file
 * clip is saved, under what name.
 *
 * Off unless asked for (`clipsync receive on`, or CLIPSYNC_RECEIVE_FILES=on):
 * a download nobody asked for is not a paste.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { AgentConfig } from "./config";

export interface ReceiveSettings {
  on: boolean;
  /** Where received files are saved. */
  dir: string;
}

const onOff = (value: string | undefined): boolean | null =>
  value === undefined || value === ""
    ? null
    : /^(1|on|true|yes)$/i.test(value)
      ? true
      : /^(0|off|false|no)$/i.test(value)
        ? false
        : null;

/** The settings in force: the environment first, then the config file. */
export function receiveSettings(
  config: Pick<AgentConfig, "receiveFiles" | "receiveDir">,
  env: NodeJS.ProcessEnv = process.env,
): ReceiveSettings {
  return {
    on: onOff(env.CLIPSYNC_RECEIVE_FILES) ?? config.receiveFiles ?? false,
    dir: env.CLIPSYNC_RECEIVE_DIR || config.receiveDir || join(downloadsDir(env), "ClipSync"),
  };
}

/**
 * The user's Downloads folder. On Linux that is XDG_DOWNLOAD_DIR from
 * user-dirs.dirs, which desktops set to the folder's local name
 * ("Téléchargements"); elsewhere, and failing that, ~/Downloads.
 */
export function downloadsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (process.platform === "linux") {
    const file = join(env.XDG_CONFIG_HOME || join(home, ".config"), "user-dirs.dirs");
    try {
      const dir = xdgDownloadDir(readFileSync(file, "utf8"), home);
      if (dir) return dir;
    } catch {
      // No user-dirs.dirs: the default below.
    }
  }
  return join(home, "Downloads");
}

/** XDG_DOWNLOAD_DIR="$HOME/Downloads", as xdg-user-dirs writes it. */
export function xdgDownloadDir(file: string, home: string): string | null {
  const match = /^XDG_DOWNLOAD_DIR="([^"]*)"/m.exec(file);
  if (!match) return null;
  const dir = match[1]!.replace(/^\$HOME(?=\/|$)/, home);
  // Only absolute paths; "$HOME/" alone means "disabled" to xdg-user-dirs.
  return dir.startsWith("/") && dir.replace(/\/+$/, "") !== home ? dir : null;
}

/** Names Windows reserves, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A file name that is safe to create: the envelope's name is another
 * device's say-so, so no directories, no control characters, nothing a
 * file system refuses, and never empty or a dot-file.
 */
export function safeName(name: string): string {
  let clean = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 200);
  const stem = clean.slice(0, clean.length - extname(clean).length);
  if (RESERVED.test(stem)) clean = `_${clean}`;
  return clean || "file";
}

/** "report.pdf", then "report (1).pdf", "report (2).pdf", ... */
function numbered(name: string, n: number): string {
  if (n === 0) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * Save a received file into `dir` and return its path. A file already there
 * with the same name and bytes is reused (the same clip received again);
 * another file never is overwritten.
 */
export async function saveReceived(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const base = safeName(name);
  for (let n = 0; ; n++) {
    const path = join(dir, numbered(base, n));
    const existing = await stat(path).catch(() => null);
    if (existing) {
      if (
        existing.isFile() &&
        existing.size === bytes.length &&
        createHash("sha256").update(await readFile(path)).digest("hex") === digest
      ) {
        return path;
      }
      continue;
    }
    try {
      // wx: never replace a file that appeared since the stat.
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}
