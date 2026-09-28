/**
 * The build stamp shown by `clipsync status` and the tray panel.
 *
 * `git describe --always --dirty` gives the commit, suffixed `-dirty` when
 * the tree had uncommitted changes -- enough to tell at a glance whether a
 * running binary is the code you think it is. Falls back to "unknown" outside
 * a git checkout, such as a source tarball.
 */

import { execFileSync } from "node:child_process";

export function buildId() {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
