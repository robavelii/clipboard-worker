import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  detectClipboard,
  macos,
  parseUriList,
  powershellBackend,
  type ClipboardBackend,
} from "../src/clipboard";
import { extensionFor, mimeFor } from "../src/mime";

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
 * `die` exits after one reply, `mute` never answers. Like the real one, it
 * answers "OK =" to an image request when nothing was written since the last.
 * FAKE_FILES holds copied files' paths, separated by "|".
 */
const FAKE_HELPER = `
const mode = process.env.FAKE_MODE ?? "";
let clip = "";
let image = "";
let files = process.env.FAKE_FILES ?? "";
let seq = 0;
let imageSeq = -1;
let served = 0;
let watching = false;
// Like the real helper's listener thread: a change line, ahead of the reply.
const changed = () => { if (watching) process.stdout.write("C\\n"); };
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
      else { clip = text; seq++; changed(); process.stdout.write("OK\\n"); }
    } else if (line === "I") {
      process.stdout.write(seq === imageSeq ? "OK =\\n" : "OK " + image + "\\n");
      imageSeq = seq;
    } else if (line.startsWith("J ")) {
      image = line.slice(2); seq++; changed(); process.stdout.write("OK\\n");
    } else if (line === "L") {
      watching = true;
      process.stdout.write("OK\\n");
    } else if (line === "F") {
      process.stdout.write("OK " + Buffer.from(files.split("|").join("\\n")).toString("base64") + "\\n");
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

  it("round-trips an image, remembering it while the clipboard is unchanged", async () => {
    const b = make();
    expect(await b.readImage!()).toBeNull();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await b.writeImage!({ bytes, mime: "image/png" });
    const first = await b.readImage!();
    expect(first?.mime).toBe("image/png");
    expect([...first!.bytes]).toEqual([...bytes]);
    // The helper now answers "unchanged"; the backend hands back what it had.
    expect([...(await b.readImage!())!.bytes]).toEqual([...bytes]);
    await b.write("text now");
    expect(await b.readImage!()).not.toBeNull();
  });

  it("lists files copied in Explorer", async () => {
    process.env.FAKE_FILES = "C:\\Users\\rob\\Downloads\\hadra.jpg|C:\\notes.pdf";
    const b = make();
    expect(await b.readFiles!()).toEqual(["C:\\Users\\rob\\Downloads\\hadra.jpg", "C:\\notes.pdf"]);
  });

  it("lists no files when none were copied", async () => {
    expect(await make().readFiles!()).toEqual([]);
  });

  it("announces changes between replies, without mistaking them for one", async () => {
    const b = make();
    let changes = 0;
    const watch = await b.watch!(() => changes++, () => undefined);
    expect(watch.via).toBe("AddClipboardFormatListener");
    await b.write("one");
    expect(await b.read()).toBe("one");
    await b.writeImage!({ bytes: new Uint8Array([1, 2]), mime: "image/png" });
    expect(await b.read()).toBe("one");
    expect(changes).toBe(2);
    watch.stop();
    await b.write("two");
    expect(changes).toBe(2);
  });

  it("says so when the helper that was watching dies", async () => {
    const b = make("die");
    const lost = new Promise<string>((resolve) => void b.watch!(() => undefined, resolve));
    expect(await lost).toMatch(/PowerShell exited/);
  });
});

/**
 * wl-paste stand-in: the clipboard is a directory with one file per MIME
 * type, named with "/" as "_" -- `--list-types` lists them, `--type` reads one.
 */
describe("Wayland backend", () => {
  let offers: string;
  beforeAll(async () => {
    offers = join(dir, "offers");
    await writeFile(
      join(dir, "wl-paste"),
      `#!/bin/sh
d="${join(dir, "offers")}"
if [ "$1" = "--watch" ]; then
  shift
  if [ "$FAKE_WATCH" = refuse ]; then
    echo "Watch mode requires a compositor that supports the wlroots data-control protocol" >&2
    exit 1
  fi
  # Once at start, as wl-paste does, then once per FAKE_WATCH_EVENTS copy.
  i=0
  while :; do
    echo copied | "$@"
    i=$((i + 1))
    [ "$i" -gt "\${FAKE_WATCH_EVENTS:-0}" ] && break
    sleep 0.05
  done
  exec sleep 60
fi
if [ "$1" = "--list-types" ]; then
  [ -n "$(ls "$d" 2>/dev/null)" ] || { echo "No selection" >&2; exit 1; }
  ls "$d" | sed 's#_#/#'
  exit 0
fi
while [ $# -gt 0 ]; do [ "$1" = "--type" ] && t="$2"; shift; done
[ -n "$t" ] || { echo "no --type: would pick any text/*" >&2; exit 1; }
cat "$d/$(printf '%s' "$t" | sed 's#/#_#')"
`,
    );
    await chmod(join(dir, "wl-paste"), 0o755);
  });

  const offer = async (types: Record<string, string | Uint8Array>) => {
    await rm(offers, { recursive: true, force: true });
    await mkdir(offers);
    for (const [type, data] of Object.entries(types)) {
      await writeFile(join(offers, type.replace("/", "_")), data);
    }
    process.env.PATH = `${dir}:${saved.PATH}`;
    process.env.CLIPSYNC_CLIPBOARD = "wayland";
    return detectClipboard();
  };

  // A browser's "Copy image": left to choose, wl-paste would take the
  // text/html flavour and the agent would push markup instead of the image.
  it("reads a browser's copied image, not its HTML", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    const clip = await offer({ "text/html": '<img src="https://example.com/a.png">', "image/png": png });
    expect(await clip.read()).toBe("");
    const image = await clip.readImage!();
    expect(image?.mime).toBe("image/png");
    expect([...image!.bytes]).toEqual([...png]);
  });

  it("reads the plain-text flavour when there is one", async () => {
    const clip = await offer({ "text/html": "<b>hi</b>", "text/plain;charset=utf-8": "hi ✓" });
    expect(await clip.read()).toBe("hi ✓");
  });

  it("reads a JPEG when that is the only image type offered", async () => {
    const clip = await offer({ "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff]) });
    expect((await clip.readImage!())?.mime).toBe("image/jpeg");
  });

  it("reads files copied in a file manager", async () => {
    const clip = await offer({
      "text/plain": "/home/rob/Downloads/hadra photo.jpg",
      "text/uri-list": "file:///home/rob/Downloads/hadra%20photo.jpg\r\n",
    });
    expect(await clip.readFiles!()).toEqual(["/home/rob/Downloads/hadra photo.jpg"]);
  });

  it("treats an empty clipboard as empty, not as a failure", async () => {
    const clip = await offer({});
    expect(await clip.read()).toBe("");
    expect(await clip.readImage!()).toBeNull();
    expect(await clip.readFiles!()).toEqual([]);
  });

  it("announces each copy through wl-paste --watch, not the state at start", async () => {
    process.env.FAKE_WATCH_EVENTS = "3";
    const clip = await offer({ "text/plain": "hi" });
    let changes = 0;
    const watch = await clip.watch!(() => changes++, () => undefined);
    try {
      expect(watch.via).toBe("wl-paste --watch");
      await new Promise((r) => setTimeout(r, 600));
      expect(changes).toBe(3);
    } finally {
      watch.stop();
    }
  });

  it("cannot watch on a compositor without data-control", async () => {
    process.env.FAKE_WATCH = "refuse";
    delete process.env.DISPLAY;
    const clip = await offer({ "text/plain": "hi" });
    await expect(clip.watch!(() => undefined, () => undefined)).rejects.toThrow(/data-control/);
  });
});

describe("uri lists", () => {
  it("decodes local file URIs to paths", () => {
    expect(parseUriList("# comment\r\nfile:///tmp/a%20b.jpg\r\nfile://localhost/tmp/c.png\r\n")).toEqual([
      "/tmp/a b.jpg",
      "/tmp/c.png",
    ]);
  });

  it("is not a file copy if any entry is not a local file", () => {
    expect(parseUriList("file:///tmp/a.jpg\nhttps://example.com/b.jpg")).toEqual([]);
    expect(parseUriList("file://otherhost/tmp/a.jpg")).toEqual([]);
    expect(parseUriList("not a uri")).toEqual([]);
  });
});

describe("MIME types", () => {
  it("come from a file's extension, whatever its case", () => {
    expect(mimeFor("hadra.JPG")).toBe("image/jpeg");
    expect(mimeFor("notes.pdf")).toBe("application/pdf");
    expect(mimeFor("Makefile")).toBe("application/octet-stream");
    expect(mimeFor(".jpg")).toBe("application/octet-stream");
  });

  it("name an image that came without a name", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/x-unknown")).toBe("bin");
  });
});

// The real helper script, run by PowerShell 7 -- on Linux its clipboard
// cmdlets go through xclip, so this needs a display. Set CLIPSYNC_TEST_PWSH
// to a pwsh binary to run it.
describe.skipIf(!process.env.CLIPSYNC_TEST_PWSH || !process.env.DISPLAY)("PowerShell helper", () => {
  // The listener's C# compiles here; only Windows has the user32 it calls.
  it.skipIf(process.platform === "win32")("compiles the change listener, and says it cannot listen off Windows", async () => {
    const b = powershellBackend([process.env.CLIPSYNC_TEST_PWSH!], { start: 60_000 });
    try {
      // The helper's own refusal ("clipboard: ..."), not a helper that died.
      await expect(b.watch!(() => undefined, () => undefined)).rejects.toThrow(/^clipboard: /);
    } finally {
      b.close?.();
    }
  }, 90_000);

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

  it("round-trips an image, in its own type", async () => {
    process.env.CLIPSYNC_CLIPBOARD = "x11";
    const clip = await detectClipboard();
    await clip.writeImage!({ bytes: png, mime: "image/png" });
    expect([...(await clip.readImage!())!.bytes]).toEqual([...png]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    await clip.writeImage!({ bytes: jpeg, mime: "image/jpeg" });
    const back = await clip.readImage!();
    expect(back?.mime).toBe("image/jpeg");
    expect([...back!.bytes]).toEqual([...jpeg]);
  });

  // xclip, owning the selection with an image, answers a text request with
  // the image's bytes. Without the TARGETS check the agent would push a PNG
  // back as text after applying one.
  it("reads no text while the clipboard holds only an image", async () => {
    process.env.CLIPSYNC_CLIPBOARD = "x11";
    const clip = await detectClipboard();
    await clip.writeImage!({ bytes: png, mime: "image/png" });
    expect(await clip.read()).toBe("");
    await clip.write("plain text");
    expect(await clip.read()).toBe("plain text");
    expect(await clip.readImage!()).toBeNull();
    expect(await clip.readFiles!()).toEqual([]);
  });

  it("reads files from a uri list", async () => {
    process.env.CLIPSYNC_CLIPBOARD = "x11";
    const clip = await detectClipboard();
    // xclip forks a child that holds the selection, and the pipes with it.
    execFileSync("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-i"], {
      input: "file:///tmp/hadra%20photo.jpg\r\n",
      stdio: ["pipe", "ignore", "ignore"],
    });
    expect(await clip.readFiles!()).toEqual(["/tmp/hadra photo.jpg"]);
  });
});
