/**
 * Where this agent runs from, for the pieces that need to start it again: the
 * rebuild watcher and the background service.
 */

import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/**
 * The file this agent runs from: the executable itself when it is a
 * standalone binary (a Node single executable), else the bundle Node runs.
 * `import.meta.url` does not exist in the binary's CommonJS bundle, which is
 * why everything asks here.
 */
export function runningFile(): string {
  return isSea() ? process.execPath : fileURLToPath(import.meta.url);
}

/** The program and leading arguments that start this agent again. */
export function selfCommand(): string[] {
  return isSea() ? [process.execPath] : [process.execPath, runningFile()];
}

/**
 * Put `fresh` in place of the executable at `target`, by rename: never an
 * overwrite, which Linux refuses for a running program ("Text file busy").
 * Windows refuses even the rename over a running one, but lets it be renamed
 * aside first. Each aside gets a name of its own, since the supervisor of a
 * Windows service keeps running from the old file and it cannot be deleted
 * yet; `removeAsideBinaries` clears them once nothing runs them.
 */
export function replaceExecutable(fresh: string, target: string): void {
  try {
    renameSync(fresh, target);
  } catch (err) {
    if (process.platform !== "win32" || !existsSync(target)) throw err;
    renameSync(target, `${target}.old-${Date.now()}`);
    renameSync(fresh, target);
  }
}

/** Delete what `replaceExecutable` moved aside; any still running stays. */
export function removeAsideBinaries(target: string): void {
  const prefix = `${basename(target)}.old-`;
  try {
    for (const name of readdirSync(dirname(target))) {
      if (name.startsWith(prefix)) rmSync(join(dirname(target), name), { force: true });
    }
  } catch {
    // In use, or the folder is gone: next time.
  }
}

export { isSea };
