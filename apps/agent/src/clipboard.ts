/**
 * Linux clipboard access.
 *
 * Shells out rather than binding a native addon: `wl-clipboard` and `xclip`
 * are the tools that actually work across compositors, and a spawn every
 * ~600ms is not a cost worth optimising away.
 */

import { spawn } from "node:child_process";

export interface ClipboardBackend {
  readonly name: string;
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

function run(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function has(cmd: string): Promise<boolean> {
  try {
    const { code } = await run("which", [cmd]);
    return code === 0;
  } catch {
    return false;
  }
}

const wayland: ClipboardBackend = {
  name: "wl-clipboard",
  async read() {
    const { code, stdout, stderr } = await run("wl-paste", ["--no-newline"]);
    // wl-paste exits non-zero when the clipboard holds no text (e.g. an
    // image was copied). That is an empty read, not a failure.
    if (code !== 0) {
      if (/No suitable type|clipboard is empty/i.test(stderr)) return "";
      throw new Error(`wl-paste failed: ${stderr.trim()}`);
    }
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run("wl-copy", [], text);
    if (code !== 0) throw new Error(`wl-copy failed: ${stderr.trim()}`);
  },
};

const x11: ClipboardBackend = {
  name: "xclip",
  async read() {
    const { code, stdout, stderr } = await run("xclip", [
      "-selection",
      "clipboard",
      "-o",
    ]);
    if (code !== 0) {
      if (/Error: target .* not available/i.test(stderr)) return "";
      throw new Error(`xclip failed: ${stderr.trim()}`);
    }
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run(
      "xclip",
      ["-selection", "clipboard", "-i"],
      text,
    );
    if (code !== 0) throw new Error(`xclip failed: ${stderr.trim()}`);
  },
};

/** Pick a backend for the current session, preferring the native one. */
export async function detectClipboard(): Promise<ClipboardBackend> {
  const onWayland = Boolean(process.env.WAYLAND_DISPLAY);

  if (onWayland && (await has("wl-paste"))) return wayland;
  if (process.env.DISPLAY && (await has("xclip"))) return x11;
  if (await has("wl-paste")) return wayland;

  throw new Error(
    onWayland
      ? "install wl-clipboard: sudo apt install wl-clipboard"
      : "install xclip: sudo apt install xclip",
  );
}
