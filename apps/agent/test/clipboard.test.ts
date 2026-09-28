import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { detectClipboard, macos, powershellBackend, type ClipboardBackend } from "../src/clipboard";

let dir: string;
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipsync-clipboard-"));
});

describe("macOS backend", () => {
  // Stand-ins for pbcopy/pbpaste: a file is the clipboard, and pbcopy
  // records the locale it was started with.
  beforeAll(async () => {
    await writeFile(
      join(dir, "pbcopy"),
      `#!/bin/sh\nprintf '%s' "$LC_ALL" > "${dir}/locale"\ncat > "${dir}/clip"\n`,
    );
    await writeFile(join(dir, "pbpaste"), `#!/bin/sh\ncat "${dir}/clip" 2>/dev/null\n`);
    await chmod(join(dir, "pbcopy"), 0o755);
    await chmod(join(dir, "pbpaste"), 0o755);
  });

  it("round-trips text beyond ASCII", async () => {
    process.env.PATH = `${dir}:${saved.PATH}`;
    await macos.write("héllo ✓ 你好");
    expect(await macos.read()).toBe("héllo ✓ 你好");
  });

  it("forces a UTF-8 locale when there is none, as under launchd", async () => {
    process.env = { PATH: `${dir}:${saved.PATH}` };
    await macos.write("x");
    expect(await readFile(join(dir, "locale"), "utf8")).toBe("en_US.UTF-8");
  });

  it("keeps a UTF-8 locale the session already has", async () => {
    process.env = { PATH: `${dir}:${saved.PATH}`, LANG: "de_DE.UTF-8" };
    await macos.write("x");
    expect(await readFile(join(dir, "locale"), "utf8")).toBe("");
  });
});

/**
 * A stand-in for the PowerShell helper, speaking its protocol. FAKE_MODE
 * makes it misbehave: `crlf` hands text back with CRLF as Windows does,
 * `die` exits after one reply, `mute` never answers.
 */
const FAKE_HELPER = `
const mode = process.env.FAKE_MODE ?? "";
let clip = "";
let served = 0;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (mode === "mute") continue;
    if (line === "R") {
      const text = mode === "crlf" ? clip.replace(/\\n/g, "\\r\\n") : clip;
      process.stdout.write("OK " + Buffer.from(text).toString("base64") + "\\r\\n");
    } else if (line.startsWith("W ")) {
      const text = Buffer.from(line.slice(2), "base64").toString();
      if (text === "fail") process.stdout.write("ERR the clipboard is busy\\n");
      else { clip = text; process.stdout.write("OK\\n"); }
    }
    served++;
    if (mode === "die" && served === 1) process.exit(3);
  }
});
`;

describe("Windows backend", () => {
  let helper: string;
  let backend: ClipboardBackend | null = null;
  beforeAll(async () => {
    helper = join(dir, "fake-helper.cjs");
    await writeFile(helper, FAKE_HELPER);
  });
  afterEach(() => {
    backend?.close?.();
    backend = null;
  });

  const make = (mode = "") => {
    process.env.FAKE_MODE = mode;
    backend = powershellBackend([process.execPath, helper], { start: 2_000, read: 500, write: 500 });
    return backend;
  };

  it("round-trips text beyond ASCII through one long-lived helper", async () => {
    const b = make();
    await b.write("héllo ✓ 你好\nline two");
    expect(await b.read()).toBe("héllo ✓ 你好\nline two");
    expect(await b.read()).toBe("héllo ✓ 你好\nline two");
  });

  it("reads CRLF back as LF, so an applied clip is recognised", async () => {
    const b = make("crlf");
    await b.write("a\nb");
    expect(await b.read()).toBe("a\nb");
  });

  it("serialises concurrent requests", async () => {
    const b = make();
    const results = await Promise.all([b.write("one"), b.read(), b.write("two"), b.read()]);
    expect(results).toEqual([undefined, "one", undefined, "two"]);
  });

  it("surfaces the helper's errors", async () => {
    await expect(make().write("fail")).rejects.toThrow(/busy/);
  });

  it("starts a new helper when the old one dies", async () => {
    const b = make("die");
    await b.write("first");
    await expect(b.read()).rejects.toThrow(/exited|answer/);
    await b.write("second");
  });

  it("gives up on a helper that stops answering", async () => {
    await expect(make("mute").read()).rejects.toThrow(/did not answer/);
  });
});

// The real helper script, run by PowerShell 7 -- on Linux its clipboard
// cmdlets go through xclip, so this needs a display. Set CLIPSYNC_TEST_PWSH
// to a pwsh binary to run it.
describe.skipIf(!process.env.CLIPSYNC_TEST_PWSH || !process.env.DISPLAY)("PowerShell helper", () => {
  it("reads and writes the clipboard", async () => {
    const b = powershellBackend([process.env.CLIPSYNC_TEST_PWSH!], { read: 10_000, write: 10_000 });
    try {
      await b.write("héllo from pwsh ✓\nsecond line");
      expect(await b.read()).toBe("héllo from pwsh ✓\nsecond line");
    } finally {
      b.close?.();
    }
  }, 60_000);
});

// Needs an X display and xclip, so it runs where they exist (a desktop, or
// Xvfb) and is skipped in CI.
const hasXclip = (() => {
  try {
    execFileSync("which", ["xclip"]);
    return Boolean(process.env.DISPLAY);
  } catch {
    return false;
  }
})();

describe.skipIf(!hasXclip)("X11 backend", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);

  it("round-trips an image", async () => {
    process.env.CLIPSYNC_CLIPBOARD = "x11";
    const clip = await detectClipboard();
    await clip.writeImage!(png);
    expect([...(await clip.readImage!())!]).toEqual([...png]);
  });

  // xclip, owning the selection with an image, answers a text request with
  // the image's bytes. Without the TARGETS check the agent would push a PNG
  // back as text after applying one.
  it("reads no text while the clipboard holds only an image", async () => {
    process.env.CLIPSYNC_CLIPBOARD = "x11";
    const clip = await detectClipboard();
    await clip.writeImage!(png);
    expect(await clip.read()).toBe("");
    await clip.write("plain text");
    expect(await clip.read()).toBe("plain text");
    expect(await clip.readImage!()).toBeNull();
  });
});
