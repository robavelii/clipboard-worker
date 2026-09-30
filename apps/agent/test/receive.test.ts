import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { receiveSettings, safeName, saveReceived, xdgDownloadDir } from "../src/receive";

describe("received file names", () => {
  it("keep only the name, never a path", () => {
    expect(safeName("../../.ssh/authorized_keys")).toBe("authorized_keys");
    expect(safeName("C:\\Windows\\System32\\evil.dll")).toBe("evil.dll");
    expect(safeName("/etc/passwd")).toBe("passwd");
  });

  it("drop what file systems refuse, and dot-files", () => {
    expect(safeName('re:port*?<>|".pdf')).toBe("re_port______.pdf");
    expect(safeName("tab\there\u0000.txt")).toBe("tabhere.txt");
    expect(safeName(".bashrc")).toBe("bashrc");
    expect(safeName("..")).toBe("file");
    expect(safeName("  ")).toBe("file");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("x".repeat(300))).toHaveLength(200);
  });
});

describe("the receive folder", () => {
  it("is the XDG Downloads folder where one is set", () => {
    const file = '# xdg-user-dirs\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n';
    expect(xdgDownloadDir(file, "/home/rob")).toBe("/home/rob/Téléchargements");
    expect(xdgDownloadDir('XDG_DOWNLOAD_DIR="/data/dl"', "/home/rob")).toBe("/data/dl");
    // "$HOME/" alone is how xdg-user-dirs says the folder is disabled.
    expect(xdgDownloadDir('XDG_DOWNLOAD_DIR="$HOME/"', "/home/rob")).toBeNull();
    expect(xdgDownloadDir("", "/home/rob")).toBeNull();
  });

  it("is off unless asked for; the environment outranks the config", () => {
    expect(receiveSettings({}, {}).on).toBe(false);
    expect(receiveSettings({ receiveFiles: true }, {}).on).toBe(true);
    expect(receiveSettings({ receiveFiles: true }, { CLIPSYNC_RECEIVE_FILES: "off" }).on).toBe(false);
    expect(receiveSettings({}, { CLIPSYNC_RECEIVE_FILES: "on" }).on).toBe(true);
    expect(receiveSettings({ receiveDir: "/a" }, {}).dir).toBe("/a");
    expect(receiveSettings({ receiveDir: "/a" }, { CLIPSYNC_RECEIVE_DIR: "/b" }).dir).toBe("/b");
    expect(receiveSettings({}, {}).dir).toMatch(/ClipSync$/);
  });
});

describe("saving a received file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "clipsync-receive-")), "ClipSync");
  });
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("creates the folder and the file, private to this user", async () => {
    const path = await saveReceived(dir, "report.pdf", bytes("one"));
    expect(path).toBe(join(dir, "report.pdf"));
    expect(await readFile(path, "utf8")).toBe("one");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reuses the same file received again, and never overwrites another", async () => {
    const first = await saveReceived(dir, "report.pdf", bytes("one"));
    expect(await saveReceived(dir, "report.pdf", bytes("one"))).toBe(first);
    const second = await saveReceived(dir, "report.pdf", bytes("two"));
    expect(second).toBe(join(dir, "report (1).pdf"));
    await writeFile(join(dir, "report (2).pdf"), "mine");
    expect(await saveReceived(dir, "report.pdf", bytes("three"))).toBe(join(dir, "report (3).pdf"));
    expect(await readFile(first, "utf8")).toBe("one");
    expect(await readFile(join(dir, "report (2).pdf"), "utf8")).toBe("mine");
    expect((await readdir(dir)).sort()).toEqual([
      "report (1).pdf",
      "report (2).pdf",
      "report (3).pdf",
      "report.pdf",
    ]);
  });
});
