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

/**
 * Reads are bounded. `xclip -o` asks the selection owner for the data and
 * waits for it, so an owner that has hung (a frozen app, a suspended VM
 * window) hangs the read with it -- and the poller would otherwise stack a
 * new stuck process every tick.
 *
 * Writes are not: both tools fork a child that holds the selection until
 * something else is copied, and bounding that would cut the clipboard short.
 */
const READ_TIMEOUT_MS = 5_000;

/**
 * Run a clipboard tool. Reads wait for `close`, when all of stdout is in.
 * Writes wait for `exit` instead: `xclip -i` and `wl-copy` fork a child that
 * holds the selection -- and the inherited stdio pipes -- until something
 * else is copied, so `close` would not fire until the *next* copy.
 */
function run(
  cmd: string,
  args: string[],
  stdin?: string,
  timeoutMs?: number,
  settleOn: "close" | "exit" = "close",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", timeout: timeoutMs });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    // A null code means the process was killed -- by the timeout, typically.
    // That is a failed read, not an empty clipboard.
    child.on(settleOn, (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({
        code: code ?? -1,
        stdout,
        stderr: signal ? `${stderr}killed by ${signal}` : stderr,
      }),
    );

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
    const { code, stdout, stderr } = await run(
      "wl-paste",
      ["--no-newline"],
      undefined,
      READ_TIMEOUT_MS,
    );
    // wl-paste exits non-zero when the clipboard holds no text (e.g. an
    // image was copied). That is an empty read, not a failure.
    if (code !== 0) {
      if (/No suitable type|clipboard is empty/i.test(stderr)) return "";
      throw new Error(`wl-paste failed: ${stderr.trim()}`);
    }
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run("wl-copy", [], text, undefined, "exit");
    if (code !== 0) throw new Error(`wl-copy failed: ${stderr.trim()}`);
  },
};

const x11: ClipboardBackend = {
  name: "xclip",
  async read() {
    const { code, stdout, stderr } = await run(
      "xclip",
      ["-selection", "clipboard", "-o"],
      undefined,
      READ_TIMEOUT_MS,
    );
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
      undefined,
      "exit",
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
