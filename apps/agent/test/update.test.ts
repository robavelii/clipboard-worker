import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isOlderRelease, parseRelease } from "@clipsync/protocol";
import { latestRelease, listedDigest, ReleaseWontRunError, updateTo } from "../src/update";

/** A stand-in "binary": a script that reports a version when asked. */
const fakeBinary = (says: string) => `#!/bin/sh\necho "${says}"\n[ "$1" = --version ] || sleep 30\n`;

/**
 * GitHub's release pages, as the updater uses them: `latest` redirects to
 * the tag, and each release serves the gzipped binary and SHA256SUMS.
 */
const release = { tag: "v0.4.0", binary: fakeBinary("clipsync v0.4.0"), sums: null as string | null, missing: false };
let server: Server;
let releases: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const gz = gzipSync(Buffer.from(release.binary));
    if (req.url === "/o/r/releases/latest") {
      if (release.missing) return void res.writeHead(404).end();
      return void res.writeHead(302, { location: `https://github.com/o/r/releases/tag/${release.tag}` }).end();
    }
    if (req.url === `/o/r/releases/download/${release.tag}/clipsync-linux-x64.gz`) return void res.end(gz);
    if (req.url === `/o/r/releases/download/${release.tag}/SHA256SUMS`) {
      const digest = createHash("sha256").update(gz).digest("hex");
      return void res.end(release.sums ?? `${digest}  clipsync-linux-x64.gz\n${"0".repeat(64)}  clipsync-windows-x64.gz\n`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  releases = `http://127.0.0.1:${port}/o/r/releases`;
});
afterAll(() => server.close());
beforeEach(() => {
  Object.assign(release, { tag: "v0.4.0", binary: fakeBinary("clipsync v0.4.0"), sums: null, missing: false });
});

/** An installed "clipsync" reporting `version`, in a folder of its own. */
function installed(version: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "clipsync-update-")), "clipsync");
  writeFileSync(path, fakeBinary(`clipsync ${version}`), { mode: 0o755 });
  return path;
}

const opts = () => ({ releases, target: "linux-x64" });
const version = (path: string) => execFileSync(path, ["--version"], { encoding: "utf8" }).trim();

describe("release tags", () => {
  it("parse and compare as numbers, not strings", () => {
    expect(parseRelease("v1.20.3")).toEqual([1, 20, 3]);
    expect(parseRelease("e7f8cb9-dirty")).toBeNull();
    expect(isOlderRelease("v0.9.0", "v0.10.0")).toBe(true);
    expect(isOlderRelease("v0.10.0", "v0.9.0")).toBe(false);
    expect(isOlderRelease("v0.4.0", "v0.4.0")).toBe(false);
    expect(isOlderRelease("e7f8cb9", "v9.9.9")).toBe(false);
  });

  it("find a file's digest in SHA256SUMS, in text or binary mode", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(listedDigest(`${a}  one.gz\n${b} *two.gz\n`, "two.gz")).toBe("b".repeat(64));
    expect(listedDigest(`${a}  one.gz\n`, "three.gz")).toBeNull();
  });
});

describe("latestRelease", () => {
  it("reads the tag from GitHub's redirect", async () => {
    expect(await latestRelease(releases)).toBe("v0.4.0");
  });

  it("finds none when there is no release, or it is not a release tag", async () => {
    release.missing = true;
    expect(await latestRelease(releases)).toBeNull();
    release.missing = false;
    release.tag = "nightly";
    expect(await latestRelease(releases)).toBeNull();
  });
});

describe("updateTo", () => {
  it("replaces an older release with the newest", async () => {
    const path = installed("v0.3.0");
    expect(await updateTo("v0.3.0", path, opts())).toEqual({ status: "updated", from: "v0.3.0", to: "v0.4.0" });
    expect(version(path)).toBe("clipsync v0.4.0");
    expect(existsSync(`${path}.new`)).toBe(false);
  });

  it("replaces the binary while it is running", async () => {
    const path = installed("v0.3.0");
    const running = spawn(path, [], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect((await updateTo("v0.3.0", path, opts())).status).toBe("updated");
      expect(version(path)).toBe("clipsync v0.4.0");
    } finally {
      running.kill();
    }
  });

  it("never moves backwards or sideways", async () => {
    expect(await updateTo("v0.4.0", installed("v0.4.0"), opts())).toEqual({ status: "current", latest: "v0.4.0" });
    expect(await updateTo("v0.5.0", installed("v0.5.0"), opts())).toEqual({ status: "current", latest: "v0.4.0" });
    expect(await updateTo("e7f8cb9", installed("e7f8cb9"), opts())).toEqual({ status: "not-a-release", build: "e7f8cb9" });
  });

  it("refuses a download that does not match SHA256SUMS", async () => {
    release.sums = `${"f".repeat(64)}  clipsync-linux-x64.gz\n`;
    const path = installed("v0.3.0");
    await expect(updateTo("v0.3.0", path, opts())).rejects.toThrow(/checksum/);
    expect(version(path)).toBe("clipsync v0.3.0");
    expect(existsSync(`${path}.new`)).toBe(false);
  });

  it("refuses a binary that is not the release it was fetched as", async () => {
    release.binary = fakeBinary("clipsync v0.3.9");
    const path = installed("v0.3.0");
    await expect(updateTo("v0.3.0", path, opts())).rejects.toThrow(/does not run as it should/);
    expect(readFileSync(path, "utf8")).toContain("clipsync v0.3.0");
    expect(existsSync(`${path}.new`)).toBe(false);
  });

  it("names a release that will not run here, so the daemon can stop fetching it", async () => {
    // As on a Mac older than the release's Node supports: it downloads, then fails to start.
    release.binary = "#!/bin/sh\necho 'dyld: Symbol not found' >&2\nexit 1\n";
    const path = installed("v0.3.0");
    const error = await updateTo("v0.3.0", path, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReleaseWontRunError);
    expect((error as ReleaseWontRunError).tag).toBe("v0.4.0");
    expect((error as Error).message).toMatch(/dyld: Symbol not found/);

    expect(await updateTo("v0.3.0", path, { ...opts(), skip: new Set(["v0.4.0"]) })).toEqual({
      status: "skipped",
      latest: "v0.4.0",
    });
    expect(version(path)).toBe("clipsync v0.3.0");

    release.tag = "v0.5.0";
    release.binary = fakeBinary("clipsync v0.5.0");
    expect((await updateTo("v0.3.0", path, { ...opts(), skip: new Set(["v0.4.0"]) })).status).toBe("updated");
  });
});
