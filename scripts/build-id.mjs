/**
 * The build stamp shown by `clipsync status` and the tray panel.
 *
 * `git describe --always --dirty` gives the commit, suffixed `-dirty` when
 * the tree had uncommitted changes -- enough to tell at a glance whether a
 * running binary is the code you think it is. Falls back to "unknown" outside
 * a git checkout, such as a source tarball. A release build sets
 * CLIPSYNC_BUILD_ID to its tag instead.
 */

import { execFileSync } from "node:child_process";

/**
 * Where a standalone agent looks for newer releases of itself: the GitHub
 * releases of the repo it was built from (GITHUB_REPOSITORY in CI). Baked in
 * at build time, never taken from the server -- see decisions §34.
 */
export function releasesUrl() {
  if (process.env.CLIPSYNC_RELEASES) return process.env.CLIPSYNC_RELEASES;
  const repo = process.env.GITHUB_REPOSITORY || "robavelii/clipboard-worker";
  return `https://github.com/${repo}/releases`;
}

export function buildId() {
  if (process.env.CLIPSYNC_BUILD_ID) return process.env.CLIPSYNC_BUILD_ID;
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
