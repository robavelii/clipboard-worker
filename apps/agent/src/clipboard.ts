/**
 * Clipboard access on Linux, macOS and Windows.
 *
 * Shells out rather than binding a native addon. On Linux, `wl-clipboard`
 * and `xclip` are the tools that actually work across compositors; on macOS,
 * `pbpaste`/`pbcopy`. On Windows, starting PowerShell is too slow to repeat,
 * so one PowerShell process stays up and answers requests (see
 * `powershellBackend`).
 *
 * Each backend can also say when the clipboard changes (`watch`, decisions
 * §36), so the daemon reads it after a copy instead of every 600 ms.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchClipboardOwner } from "./x11";

export interface ClipboardImage {
  bytes: Uint8Array;
  /** One of the backend's `imageTypes`. */
  mime: string;
}

/** A running subscription to clipboard changes. */
export interface ClipboardWatch {
  /** What delivers the events, for the log: "XFixes", "wl-paste --watch". */
  readonly via: string;
  stop(): void;
}

export interface ClipboardBackend {
  readonly name: string;
  /**
   * The clipboard's text, or "" when it offers none. Never a markup flavour
   * such as text/html: a browser's "Copy image" offers one beside the image.
   */
  read(): Promise<string>;
  write(text: string): Promise<void>;
  /** The image on the clipboard, in the first of `imageTypes` it offers. */
  readImage?(): Promise<ClipboardImage | null>;
  writeImage?(image: ClipboardImage): Promise<void>;
  /** Image types writeImage takes, and readImage looks for, best first. */
  readonly imageTypes?: readonly string[];
  /**
   * Local paths of files copied in a file manager, or none. Their text
   * flavour is only the paths, which is not what anyone copied them for.
   */
  readFiles?(): Promise<string[]>;
  /**
   * Whether a copy of files always offers text too (Finder: their names), so
   * a clipboard without text need not be asked for files -- worth knowing
   * where asking means starting a process.
   */
  readonly filesOfferText?: boolean;
  /**
   * Call `onChange` whenever the clipboard may have changed: every copy,
   * this agent's own writes included, and perhaps more. Resolves once
   * watching; rejects when this machine cannot (the daemon then polls).
   * `onLost` is called if watching stops by itself later.
   */
  watch?(onChange: () => void, onLost: (why: string) => void): Promise<ClipboardWatch>;
  /** Release anything the backend holds open. */
  close?(): void;
}

/** Image types the Linux tools read and write as they are, best first. */
const LINUX_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;

/** The first of `wanted` that a list of offered targets or MIME types holds. */
function firstOffered(offered: string, wanted: readonly string[]): string | null {
  const lines = new Set(offered.split(/\r?\n/).map((line) => line.trim()));
  return wanted.find((type) => lines.has(type)) ?? null;
}

/**
 * Local paths from a text/uri-list. Comments are skipped; anything that is
 * not a local file (a web link dragged from a browser, a file on another
 * host) means this is not a file copy at all, so nothing is returned.
 */
export function parseUriList(list: string): string[] {
  const paths: string[] = [];
  for (const raw of list.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const url = new URL(line);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return [];
      url.hostname = "";
      paths.push(fileURLToPath(url));
    } catch {
      return [];
    }
  }
  return paths;
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
  stdin?: string | Uint8Array;
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
): Promise<{ code: number; stdout: string; bytes: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", timeout: timeoutMs, env });
    // Kept as bytes: an image read is binary, and text is decoded once at the
    // end rather than per chunk, which could split a UTF-8 sequence.
    const out: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    // A null code means the process was killed -- by the timeout, typically.
    // That is a failed read, not an empty clipboard.
    child.on(settleOn, (code: number | null, signal: NodeJS.Signals | null) => {
      const bytes = Buffer.concat(out);
      resolve({
        code: code ?? -1,
        stdout: bytes.toString("utf8"),
        bytes,
        stderr: signal ? `${stderr}killed by ${signal}` : stderr,
      });
    });

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

/** How long a watcher may take to start before the daemon polls instead. */
const WATCH_START_MS = 5_000;

/**
 * A long-lived process that prints a line when the clipboard changes. Its
 * first line means it is watching, and is not itself a change. A process
 * that exits before that could not watch; one that exits after is lost.
 */
function lineWatcher(
  via: string,
  cmd: string,
  args: string[],
  stream: "stdout" | "stderr",
  onChange: () => void,
  onLost: (why: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<ClipboardWatch> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe", env, windowsHide: true });
    let watching = false;
    let stopped = false;
    let output = "";
    let buffer = "";
    const watch: ClipboardWatch = {
      via,
      stop() {
        stopped = true;
        child.kill();
      },
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${via} did not start in time`));
    }, WATCH_START_MS);

    child.stdin.end();
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        buffer = buffer.slice(newline + 1);
        if (watching) {
          onChange();
        } else {
          watching = true;
          clearTimeout(timer);
          resolve(watch);
        }
      }
    });
    const other = stream === "stdout" ? child.stderr : child.stdout;
    other.setEncoding("utf8");
    other.on("data", (chunk: string) => {
      output = (output + chunk).slice(-500);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (watching) {
        if (!stopped) onLost(err.message);
      } else reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const why = `${via} exited (${code})${output.trim() ? `: ${output.trim()}` : ""}`;
      if (watching) {
        if (!stopped) onLost(why);
      } else reject(new Error(why));
    });
  });
}

/* -------------------------------- Linux -------------------------------- */

/** Plain-text flavours, best first. Both tools list X11 and MIME names alike. */
const TEXT_TYPES = [
  "text/plain;charset=utf-8",
  "UTF8_STRING",
  "text/plain",
  "STRING",
  "TEXT",
] as const;

/** What the Wayland clipboard offers, one type per line; "" when it is empty. */
async function waylandTypes(): Promise<string> {
  const { code, stdout, stderr } = await run("wl-paste", ["--list-types"], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (code === 0) return stdout;
  // Wording differs across wl-clipboard versions.
  if (/Nothing is copied|No selection|clipboard is empty|No suitable type/i.test(stderr)) return "";
  throw new Error(`wl-paste failed: ${stderr.trim()}`);
}

async function wlPaste(type: string): Promise<Buffer | null> {
  const { code, bytes } = await run("wl-paste", ["--no-newline", "--type", type], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  return code === 0 && bytes.length ? bytes : null;
}

const wayland: ClipboardBackend = {
  name: "wl-clipboard",
  imageTypes: LINUX_IMAGE_TYPES,
  async read() {
    // Name the type: left to choose, wl-paste takes any text/* flavour, and
    // a browser's "Copy image" offers text/html beside the picture.
    const type = firstOffered(await waylandTypes(), TEXT_TYPES);
    if (!type) return "";
    return (await wlPaste(type))?.toString("utf8") ?? "";
  },
  async write(text) {
    const { code, stderr } = await run("wl-copy", [], { stdin: text, settleOn: "exit" });
    if (code !== 0) throw new Error(`wl-copy failed: ${stderr.trim()}`);
  },
  async readImage() {
    const mime = firstOffered(await waylandTypes(), LINUX_IMAGE_TYPES);
    const bytes = mime ? await wlPaste(mime) : null;
    return mime && bytes ? { bytes: new Uint8Array(bytes), mime } : null;
  },
  async writeImage({ bytes, mime }) {
    const { code, stderr } = await run("wl-copy", ["--type", mime], {
      stdin: bytes,
      settleOn: "exit",
    });
    if (code !== 0) throw new Error(`wl-copy failed: ${stderr.trim()}`);
  },
  async readFiles() {
    if (!firstOffered(await waylandTypes(), ["text/uri-list"])) return [];
    return parseUriList((await wlPaste("text/uri-list"))?.toString("utf8") ?? "");
  },
  // wl-paste runs the command for every new selection, and once at start.
  // The command drains what it is handed, so the copying app's write
  // completes, and prints a line. Compositors without the data-control
  // protocol (GNOME's) refuse --watch; XWayland's clipboard, which the
  // compositor keeps in step, can still announce copies there.
  async watch(onChange, onLost) {
    try {
      return await lineWatcher(
        "wl-paste --watch",
        "wl-paste",
        ["--watch", "sh", "-c", "cat >/dev/null; echo"],
        "stdout",
        onChange,
        onLost,
      );
    } catch (err) {
      if (!process.env.DISPLAY) throw err;
      const watch = await watchClipboardOwner(onChange, { onLost });
      return { via: "XFixes (XWayland)", stop: watch.stop };
    }
  },
};

async function x11Targets(): Promise<string | null> {
  const { code, stdout } = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  return code === 0 ? stdout : null;
}

async function xclipOut(target: string): Promise<Buffer | null> {
  const { code, bytes } = await run("xclip", ["-selection", "clipboard", "-t", target, "-o"], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  return code === 0 && bytes.length ? bytes : null;
}

const x11: ClipboardBackend = {
  name: "xclip",
  imageTypes: LINUX_IMAGE_TYPES,
  async read() {
    // Ask what the owner offers first. An owner that answers every request
    // with whatever it holds -- xclip itself does, after putting an image on
    // the clipboard -- would otherwise hand back a PNG as "text".
    // An owner that cannot list its targets gets xclip's default request.
    const targets = await x11Targets();
    const type = targets === null ? null : firstOffered(targets, TEXT_TYPES);
    if (targets !== null && !type) return "";
    const { code, stdout, stderr } = await run(
      "xclip",
      ["-selection", "clipboard", ...(type ? ["-t", type] : []), "-o"],
      { timeoutMs: READ_TIMEOUT_MS },
    );
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
  async readImage() {
    const mime = firstOffered((await x11Targets()) ?? "", LINUX_IMAGE_TYPES);
    const bytes = mime ? await xclipOut(mime) : null;
    return mime && bytes ? { bytes: new Uint8Array(bytes), mime } : null;
  },
  async writeImage({ bytes, mime }) {
    const { code, stderr } = await run("xclip", ["-selection", "clipboard", "-t", mime, "-i"], {
      stdin: bytes,
      settleOn: "exit",
    });
    if (code !== 0) throw new Error(`xclip failed: ${stderr.trim()}`);
  },
  async readFiles() {
    if (!firstOffered((await x11Targets()) ?? "", ["text/uri-list"])) return [];
    return parseUriList((await xclipOut("text/uri-list"))?.toString("utf8") ?? "");
  },
  async watch(onChange, onLost) {
    const watch = await watchClipboardOwner(onChange, { onLost });
    return { via: "XFixes", stop: watch.stop };
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

/**
 * macOS has no clipboard notification; `changeCount` is how everything on
 * the Mac notices a copy. Asking it is one call to the pasteboard server, so
 * a long-lived osascript asks ten times a second -- no process per look,
 * unlike pbpaste. JavaScript for Automation reaches AppKit through its ObjC
 * bridge; running the run loop (not a bare sleep) lets AppKit see changes.
 * console.log goes to stderr.
 */
const MACOS_WATCHER = `
ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard;
var last = pb.changeCount;
console.log('ready ' + last);
for (;;) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  var now = pb.changeCount;
  if (now !== last) {
    last = now;
    console.log('changed ' + now);
  }
}
`;

/** The pasteboard class each image type is written under. */
const MAC_IMAGE_CLASSES: Record<string, string> = {
  "image/png": "PNGf",
  "image/jpeg": "JPEG",
  "image/gif": "GIFf",
};

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
  // pbcopy and pbpaste carry text only; AppleScript reaches the pasteboard's
  // image flavours. It prints data as «data PNGf<hex>» and reads it from a file.
  imageTypes: Object.keys(MAC_IMAGE_CLASSES),
  async readImage() {
    const { code, stdout } = await run("osascript", ["-e", "the clipboard as «class PNGf»"], {
      timeoutMs: READ_TIMEOUT_MS,
      env: utf8Env(),
    });
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(stdout)?.[1];
    return code === 0 && hex ? { bytes: new Uint8Array(Buffer.from(hex, "hex")), mime: "image/png" } : null;
  },
  async writeImage({ bytes, mime }) {
    const flavour = MAC_IMAGE_CLASSES[mime];
    if (!flavour) throw new Error(`cannot put ${mime} on the clipboard`);
    const dir = await mkdtemp(join(tmpdir(), "clipsync-"));
    const file = join(dir, "clip");
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      const { code, stderr } = await run(
        "osascript",
        ["-e", `set the clipboard to (read (POSIX file "${file}") as «class ${flavour}»)`],
        { settleOn: "exit", env: utf8Env() },
      );
      if (code !== 0) throw new Error(`osascript failed: ${stderr.trim()}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  filesOfferText: true,
  // A Finder copy reads as text as the bare file name. AppleScript gives the
  // first file's path; a copy of several sends only that one.
  async readFiles() {
    const { code, stdout } = await run(
      "osascript",
      ["-e", "POSIX path of (the clipboard as «class furl»)"],
      { timeoutMs: READ_TIMEOUT_MS, env: utf8Env() },
    );
    const path = stdout.trim();
    return code === 0 && path.startsWith("/") ? [path] : [];
  },
  watch: (onChange, onLost) =>
    lineWatcher(
      "NSPasteboard changeCount",
      "osascript",
      ["-l", "JavaScript", "-e", MACOS_WATCHER],
      "stderr",
      onChange,
      onLost,
      utf8Env(),
    ),
};

/* ------------------------------- Windows ------------------------------- */

/**
 * The PowerShell side of the Windows backend: one request per line on
 * stdin, one reply per line on stdout. Clipboard text travels as base64 so
 * the pipe carries only ASCII, whatever code page the console is in.
 *
 *   R          ->  OK <base64 of the clipboard text>
 *   W <base64> ->  OK
 *   I          ->  OK <base64 of the clipboard image as PNG>, or OK and nothing,
 *                  or OK = when the clipboard has not changed since the last I
 *   J <base64> ->  OK, having put that image (PNG, JPEG, GIF or BMP) on the clipboard
 *   F          ->  OK <base64 of the copied files' paths, one per line>, or OK and nothing
 *   L          ->  OK, then a line "C" whenever the clipboard changes, between replies
 *   anything that fails -> ERR <message>
 *
 * "OK =" spares re-encoding a picture that has sat on the clipboard since
 * the last look: GDI+ turning a 4K screenshot into PNG every two seconds is
 * a core's worth of work. The clipboard's sequence number says whether
 * anything changed; where it cannot be had, every I reads afresh.
 *
 * L registers a message-only window for WM_CLIPBOARDUPDATE
 * (AddClipboardFormatListener) and pumps its messages on a thread of its
 * own. Plain Win32 through P/Invoke, not Windows Forms, so it compiles the
 * same in PowerShell 5.1 and 7.
 *
 * Works in Windows PowerShell 5.1 (every Windows 10 and 11) and PowerShell 7.
 */
const POWERSHELL_HELPER = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$in = [Console]::In
$out = [Console]::Out
$lastImageSeq = $null
$watching = $false
$watcherSource = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
namespace ClipSync {
  public static class Watcher {
    delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASS {
      public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
      public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
      public string lpszMenuName; public string lpszClassName;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WNDCLASS wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    const uint WM_CLIPBOARDUPDATE = 0x031D;
    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);
    // Kept in a field: the collector must not take a callback Windows holds.
    static WndProc proc;
    static string failure;
    static IntPtr Receive(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam) {
      if (msg == WM_CLIPBOARDUPDATE) {
        Console.Out.WriteLine("C");
        Console.Out.Flush();
        return IntPtr.Zero;
      }
      return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    static void Pump(object ready) {
      try {
        proc = Receive;
        WNDCLASS wc = new WNDCLASS();
        wc.lpfnWndProc = proc;
        wc.hInstance = GetModuleHandleW(null);
        wc.lpszClassName = "ClipSyncWatcher";
        if (RegisterClassW(ref wc) == 0) { failure = "RegisterClass failed (" + Marshal.GetLastWin32Error() + ")"; return; }
        IntPtr hwnd = CreateWindowExW(0, wc.lpszClassName, "ClipSync", 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) { failure = "CreateWindowEx failed (" + Marshal.GetLastWin32Error() + ")"; return; }
        if (!AddClipboardFormatListener(hwnd)) { failure = "AddClipboardFormatListener failed (" + Marshal.GetLastWin32Error() + ")"; return; }
        ((ManualResetEvent)ready).Set();
        MSG msg;
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
          TranslateMessage(ref msg);
          DispatchMessageW(ref msg);
        }
      } catch (Exception e) {
        failure = e.Message;
      } finally {
        ((ManualResetEvent)ready).Set();
      }
    }
    public static string Start() {
      ManualResetEvent ready = new ManualResetEvent(false);
      Thread thread = new Thread(Pump);
      thread.IsBackground = true;
      thread.Start(ready);
      ready.WaitOne();
      return failure;
    }
  }
}
'@
while ($null -ne ($line = $in.ReadLine())) {
  try {
    if ($line -eq 'R') {
      $text = Get-Clipboard -Raw
      if ($null -eq $text) { $text = '' }
      $out.WriteLine('OK ' + [Convert]::ToBase64String($utf8.GetBytes([string]$text)))
    } elseif ($line.StartsWith('W ')) {
      Set-Clipboard -Value $utf8.GetString([Convert]::FromBase64String($line.Substring(2)))
      $out.WriteLine('OK')
    } elseif ($line -eq 'I') {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $seq = $null
      try {
        if (-not ('ClipSync.Native' -as [type])) {
          Add-Type -Namespace ClipSync -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
        }
        $seq = [ClipSync.Native]::GetClipboardSequenceNumber()
      } catch { $seq = $null }
      if ($null -ne $seq -and $seq -eq $lastImageSeq) { $out.WriteLine('OK =') } else {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($null -eq $img) { $out.WriteLine('OK ') } else {
          $ms = New-Object System.IO.MemoryStream
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $out.WriteLine('OK ' + [Convert]::ToBase64String($ms.ToArray()))
        }
        $lastImageSeq = $seq
      }
    } elseif ($line -eq 'F') {
      Add-Type -AssemblyName System.Windows.Forms
      $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
      $out.WriteLine('OK ' + [Convert]::ToBase64String($utf8.GetBytes(($files -join "\`n"))))
    } elseif ($line -eq 'L') {
      if (-not $watching) {
        if (-not ('ClipSync.Watcher' -as [type])) { Add-Type -TypeDefinition $watcherSource }
        $failure = [ClipSync.Watcher]::Start()
        if ($failure) { throw $failure }
        $watching = $true
      }
      $out.WriteLine('OK')
    } elseif ($line.StartsWith('J ')) {
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $ms = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($line.Substring(2)))
      [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromStream($ms))
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
  /** What the helper last read as an image, for its "unchanged" answer. */
  let lastImage: ClipboardImage | null = null;
  /** Whoever asked the helper to watch (L); its "C" lines go here. */
  let watcher: { onChange: () => void; onLost: (why: string) => void } | null = null;

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
    // A new helper has no memory of the last image, so never answers "=" first.
    lastImage = null;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        // A change, from the watching thread, between replies.
        if (line === "C") {
          watcher?.onChange();
          continue;
        }
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
      // A new helper would not be watching.
      const lost = watcher;
      watcher = null;
      lost?.onLost(`PowerShell ${why}`);
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
    // GDI+ decodes all of these, and hands every one back as PNG.
    imageTypes: ["image/png", "image/jpeg", "image/gif", "image/bmp"],
    // Windows re-encodes what it hands back, so these bytes are not the ones
    // written; the daemon re-reads after writing an image for that reason.
    async readImage() {
      const payload = expectOk(await request("I", readMs));
      if (payload !== "=") {
        lastImage = payload ? { bytes: new Uint8Array(Buffer.from(payload, "base64")), mime: "image/png" } : null;
      }
      return lastImage;
    },
    async writeImage({ bytes }) {
      expectOk(await request(`J ${Buffer.from(bytes).toString("base64")}`, writeMs));
    },
    async readFiles() {
      const payload = expectOk(await request("F", readMs));
      return Buffer.from(payload, "base64").toString("utf8").split("\n").map((p) => p.trim()).filter(Boolean);
    },
    async watch(onChange, onLost) {
      // Compiling the listener is PowerShell's slow part: allow for it.
      expectOk(await request("L", startMs));
      const mine = { onChange, onLost };
      watcher = mine;
      return {
        via: "AddClipboardFormatListener",
        stop() {
          if (watcher === mine) watcher = null;
        },
      };
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
