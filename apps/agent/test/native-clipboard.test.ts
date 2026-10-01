/**
 * Each platform's real clipboard, where the test runs on it: the Release
 * workflow runs this file on its Linux (Xvfb), macOS and Windows runners.
 * Elsewhere it skips.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectClipboard, type ClipboardBackend } from "../src/clipboard";

const hasXclip = (() => {
  if (process.platform !== "linux" || !process.env.DISPLAY) return false;
  try {
    execFileSync("which", ["xclip"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const native = hasXclip || process.platform === "darwin" || process.platform === "win32";

describe.skipIf(!native)("this machine's clipboard", () => {
  let clipboard: ClipboardBackend;
  let file: string;

  beforeAll(async () => {
    if (hasXclip) process.env.CLIPSYNC_CLIPBOARD = "x11";
    clipboard = await detectClipboard();
    // Real paths: the clipboard hands /var/... back as /private/var/... on macOS.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "clipsync native ")));
    file = join(dir, "réport ✓.txt");
    await writeFile(file, "a received file");
  }, 60_000);
  afterAll(() => clipboard?.close?.());

  it("round-trips text", async () => {
    await clipboard.write("native ✓ text");
    expect(await clipboard.read()).toBe("native ✓ text");
  }, 60_000);

  it("puts a file on the clipboard as a file", async () => {
    await clipboard.writeFilePath!(file);
    // macOS on Intel can answer the first read before the pasteboard has
    // the file; the daemon simply reads again on its next poll.
    let files = await clipboard.readFiles!();
    for (let i = 0; i < 20 && files.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      files = await clipboard.readFiles!();
    }
    expect(await Promise.all(files.map((f) => realpath(f)))).toEqual([file]);
  }, 60_000);

  it("announces a change", async () => {
    let changes = 0;
    const watch = await clipboard.watch!(() => changes++, () => undefined);
    try {
      await clipboard.write(`changed ${Date.now()}`);
      for (let i = 0; i < 50 && changes === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(changes).toBeGreaterThan(0);
    } finally {
      watch.stop();
    }
  }, 60_000);
});
