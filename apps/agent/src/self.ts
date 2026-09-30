/**
 * Where this agent runs from, for the pieces that need to start it again: the
 * rebuild watcher and the background service.
 */

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

export { isSea };
