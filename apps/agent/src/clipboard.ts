/**
 * Clipboard access on Linux, macOS and Windows.
 *
 * Shells out rather than binding a native addon. On Linux, `wl-clipboard`
 * and `xclip` are the tools that actually work across compositors; on macOS,
 * `pbpaste`/`pbcopy`. A spawn every ~600ms is not a cost worth optimising
 * away -- except on Windows, where starting PowerShell is, so one PowerShell
 * process stays up and answers requests (see `powershellBackend`).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface ClipboardBackend {
  readonly name: string;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  /** Release anything the backend holds open. */
  close?(): void;
}

/**
 * Reads are bounded. `xclip -o` asks the selection owner for the data and
 * waits for it, so an owner that has hung (a frozen app, a suspended VM
 * window) hangs the read with it -- and the poller would otherwise stack a
 * new stuck process every tick.
 *
 * Writes are not: both Linux tools fork a child that holds the selection
 * until something else is copied, and bounding that would cut the clipboard
 * short.
 */
const READ_TIMEOUT_MS = 5_000;

interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /**
   * Reads wait for `close`, when all of stdout is in. Writes wait for `exit`
   * instead: `xclip -i` and `wl-copy` fork a child that holds the selection
   * -- and the inherited stdio pipes -- until something else is copied, so
   * `close` would not fire until the *next* copy.
   */
  settleOn?: "close" | "exit";
  env?: NodeJS.ProcessEnv;
}

function run(
  cmd: string,
  args: string[],
  { stdin, timeoutMs, settleOn = "close", env }: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", timeout: timeoutMs, env });
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
    const { code } = await run(process.platform === "win32" ? "where" : "which", [cmd]);
    return code === 0;
  } catch {
    return false;
  }
}

/* -------------------------------- Linux -------------------------------- */

const wayland: ClipboardBackend = {
  name: "wl-clipboard",
  async read() {
    const { code, stdout, stderr } = await run("wl-paste", ["--no-newline"], {
      timeoutMs: READ_TIMEOUT_MS,
    });
    // wl-paste exits non-zero when the clipboard holds no text (e.g. an
    // image was copied). That is an empty read, not a failure.
    if (code !== 0) {
      if (/No suitable type|clipboard is empty/i.test(stderr)) return "";
      throw new Error(`wl-paste failed: ${stderr.trim()}`);
    }
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run("wl-copy", [], { stdin: text, settleOn: "exit" });
    if (code !== 0) throw new Error(`wl-copy failed: ${stderr.trim()}`);
  },
};

const x11: ClipboardBackend = {
  name: "xclip",
  async read() {
    const { code, stdout, stderr } = await run("xclip", ["-selection", "clipboard", "-o"], {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (code !== 0) {
      if (/Error: target .* not available/i.test(stderr)) return "";
      throw new Error(`xclip failed: ${stderr.trim()}`);
    }
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run("xclip", ["-selection", "clipboard", "-i"], {
      stdin: text,
      settleOn: "exit",
    });
    if (code !== 0) throw new Error(`xclip failed: ${stderr.trim()}`);
  },
};

/* -------------------------------- macOS -------------------------------- */

/**
 * `pbcopy` and `pbpaste` transcode through the locale, and launchd starts
 * jobs with none: without a UTF-8 one, anything beyond ASCII comes out
 * mangled. The session's own locale wins when it is already UTF-8.
 */
function utf8Env(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(current) ? env : { ...env, LC_ALL: "en_US.UTF-8" };
}

export const macos: ClipboardBackend = {
  name: "pbcopy",
  async read() {
    const { code, stdout, stderr } = await run("pbpaste", ["-Prefer", "txt"], {
      timeoutMs: READ_TIMEOUT_MS,
      env: utf8Env(),
    });
    if (code !== 0) throw new Error(`pbpaste failed: ${stderr.trim()}`);
    return stdout;
  },
  async write(text) {
    const { code, stderr } = await run("pbcopy", [], {
      stdin: text,
      settleOn: "exit",
      env: utf8Env(),
    });
    if (code !== 0) throw new Error(`pbcopy failed: ${stderr.trim()}`);
  },
};

/* ------------------------------- Windows ------------------------------- */

/**
 * The PowerShell side of the Windows backend: one request per line on
 * stdin, one reply per line on stdout. Clipboard text travels as base64 so
 * the pipe carries only ASCII, whatever code page the console is in.
 *
 *   R          ->  OK <base64 of the clipboard text>
 *   W <base64> ->  OK
 *   anything that fails -> ERR <message>
 *
 * Works in Windows PowerShell 5.1 (every Windows 10 and 11) and PowerShell 7.
 */
const POWERSHELL_HELPER = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$in = [Console]::In
$out = [Console]::Out
while ($null -ne ($line = $in.ReadLine())) {
  try {
    if ($line -eq 'R') {
      $text = Get-Clipboard -Raw
      if ($null -eq $text) { $text = '' }
      $out.WriteLine('OK ' + [Convert]::ToBase64String($utf8.GetBytes([string]$text)))
    } elseif ($line.StartsWith('W ')) {
      Set-Clipboard -Value $utf8.GetString([Convert]::FromBase64String($line.Substring(2)))
      $out.WriteLine('OK')
    } else {
      $out.WriteLine('ERR unknown request')
    }
  } catch {
    $out.WriteLine('ERR ' + ($_.Exception.Message -replace '[\\r\\n]+', ' '))
  }
  $out.Flush()
}
`;

/** How long PowerShell may take to start and answer its first request. */
const POWERSHELL_START_MS = 20_000;
const POWERSHELL_WRITE_MS = 10_000;

/**
 * Windows clipboard access through one long-lived PowerShell process.
 *
 * Starting PowerShell takes a few hundred milliseconds of CPU, far too much
 * to repeat every poll, so the helper stays up and requests are queued to
 * it one at a time. A helper that dies or stops answering is killed and
 * started afresh on the next request.
 *
 * Text is read with CRLF line endings turned into LF. Windows hands text out
 * with CRLF whatever was put in, so without that a clip applied from another
 * machine would read back as different text, and be pushed straight back.
 *
 * `command` is the program and any leading arguments; tests and PowerShell 7
 * users swap in their own (`CLIPSYNC_POWERSHELL=pwsh`).
 */
export function powershellBackend(
  command: string[] = ["powershell.exe"],
  timeouts: { start?: number; read?: number; write?: number } = {},
): ClipboardBackend {
  const startMs = timeouts.start ?? POWERSHELL_START_MS;
  const readMs = timeouts.read ?? READ_TIMEOUT_MS;
  const writeMs = timeouts.write ?? POWERSHELL_WRITE_MS;
  let child: ChildProcessWithoutNullStreams | null = null;
  let answered = false;
  let buffer = "";
  let waiting: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const stop = () => {
    child?.kill();
    child = null;
  };

  const start = (): ChildProcessWithoutNullStreams => {
    const [cmd, ...leading] = command as [string, ...string[]];
    // -EncodedCommand is base64 of UTF-16LE: no quoting to get wrong.
    const encoded = Buffer.from(POWERSHELL_HELPER, "utf16le").toString("base64");
    const proc = spawn(
      cmd,
      [...leading, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: "pipe", windowsHide: true },
    );
    answered = false;
    buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const current = waiting;
        waiting = null;
        current?.resolve(line);
      }
    });
    const gone = (why: string) => {
      if (child === proc) child = null;
      const current = waiting;
      waiting = null;
      current?.reject(new Error(`PowerShell ${why}`));
    };
    proc.on("error", (err) => gone(`could not start: ${err.message}`));
    proc.on("exit", (code) => gone(`exited (${code})`));
    // The helper must not keep a one-shot command such as `clipsync copy`
    // alive; a pending request's timer does that while it matters.
    proc.unref();
    (proc.stdin as unknown as { unref?: () => void }).unref?.();
    (proc.stdout as unknown as { unref?: () => void }).unref?.();
    (proc.stderr as unknown as { unref?: () => void }).unref?.();
    return proc;
  };

  const request = (line: string, timeoutMs: number): Promise<string> => {
    const next = queue.then(
      () =>
        new Promise<string>((resolve, reject) => {
          const proc = child ?? (child = start());
          const limit = answered ? timeoutMs : Math.max(timeoutMs, startMs);
          const timer = setTimeout(() => {
            waiting = null;
            if (child === proc) stop();
            reject(new Error("PowerShell did not answer in time"));
          }, limit);
          waiting = {
            resolve: (reply) => {
              clearTimeout(timer);
              answered = true;
              resolve(reply);
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          };
          proc.stdin.write(`${line}\n`);
        }),
    );
    queue = next.catch(() => undefined);
    return next;
  };

  const expectOk = (reply: string): string => {
    if (reply.startsWith("OK")) return reply.slice(3);
    throw new Error(`clipboard: ${reply.replace(/^ERR /, "")}`);
  };

  return {
    name: "powershell",
    async read() {
      const payload = expectOk(await request("R", readMs));
      return Buffer.from(payload, "base64").toString("utf8").replace(/\r\n/g, "\n");
    },
    async write(text) {
      expectOk(await request(`W ${Buffer.from(text, "utf8").toString("base64")}`, writeMs));
    },
    close: stop,
  };
}

/* ------------------------------- choosing ------------------------------ */

const BACKENDS: Record<string, () => ClipboardBackend> = {
  wayland: () => wayland,
  x11: () => x11,
  macos: () => macos,
  windows: () =>
    powershellBackend(process.env.CLIPSYNC_POWERSHELL ? [process.env.CLIPSYNC_POWERSHELL] : undefined),
};

/**
 * Pick a backend for this machine: the platform's own, and on Linux the
 * session's. `CLIPSYNC_CLIPBOARD` (wayland, x11, macos, windows) overrides
 * the choice -- for XWayland apps that only see the X11 clipboard, say.
 */
export async function detectClipboard(): Promise<ClipboardBackend> {
  const forced = process.env.CLIPSYNC_CLIPBOARD;
  if (forced) {
    const make = BACKENDS[forced];
    if (!make) {
      throw new Error(
        `CLIPSYNC_CLIPBOARD=${forced} is not one of ${Object.keys(BACKENDS).join(", ")}`,
      );
    }
    return make();
  }

  if (process.platform === "win32") return BACKENDS.windows!();
  if (process.platform === "darwin") {
    if (await has("pbpaste")) return macos;
    throw new Error("pbpaste not found -- it ships with macOS; check PATH");
  }

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
