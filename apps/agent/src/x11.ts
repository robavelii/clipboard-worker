/**
 * Clipboard change events on X11, from the XFixes extension (decisions §36).
 *
 * X11 announces a new clipboard owner -- which is what a copy is -- to any
 * client that asks, through XFixesSelectSelectionInput. No command-line tool
 * the agent can count on installed exposes that (xclip and xsel do not), and
 * a native addon would cost the single binary its portability. So this
 * speaks just enough of the X11 protocol itself, over the display's socket:
 * the connection handshake with the usual cookie, one atom, one extension
 * query, one selection-input request, then events.
 */

import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface X11Display {
  /** A Unix socket path, or a TCP host. */
  path?: string;
  host?: string;
  port?: number;
  /** The display number, as the Xauthority file names it. */
  number: string;
}

/**
 * Where a DISPLAY value points: ":0", ":1.0" and "unix:0" are the local
 * socket; "/path/to/socket:0" (XQuartz) is that socket; "host:10.0" is TCP
 * port 6010 on host (an SSH-forwarded display).
 */
export function parseDisplay(display: string): X11Display | null {
  const match = /^(.*):(\d+)(?:\.\d+)?$/.exec(display.trim());
  if (!match) return null;
  const [, host = "", number = "0"] = match;
  if (host === "" || host === "unix") return { path: `/tmp/.X11-unix/X${number}`, number };
  if (host.startsWith("/")) return { path: `${host}:${number}`, number };
  return { host, port: 6000 + Number(number), number };
}

export interface XauthEntry {
  family: number;
  address: string;
  number: string;
  name: string;
  data: Buffer;
}

const FAMILY_INTERNET = 0;
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
const COOKIE = "MIT-MAGIC-COOKIE-1";

/** An Xauthority file: records of big-endian length-prefixed fields. */
export function parseXauthority(file: Buffer): XauthEntry[] {
  const entries: XauthEntry[] = [];
  let at = 0;
  const field = (): Buffer => {
    const length = file.readUInt16BE(at);
    const value = file.subarray(at + 2, at + 2 + length);
    if (value.length !== length) throw new RangeError("truncated");
    at += 2 + length;
    return value;
  };
  try {
    while (at < file.length) {
      const family = file.readUInt16BE(at);
      at += 2;
      const address = field().toString("latin1");
      const number = field().toString("latin1");
      const name = field().toString("latin1");
      const data = field();
      entries.push({ family, address, number, name, data });
    }
  } catch {
    // A truncated last record: keep what was whole.
  }
  return entries;
}

/**
 * The cookie for a display: this host's own entry first, then a wildcard,
 * then any entry for that display number. None, and the connection goes
 * unauthenticated, which a server allowing local users by host accepts.
 */
export function cookieFor(entries: XauthEntry[], display: X11Display, host = hostname()): Buffer | null {
  const candidates = entries.filter(
    (e) => e.name === COOKIE && (e.number === display.number || e.number === ""),
  );
  const local = display.path !== undefined;
  const pick =
    candidates.find((e) => (local ? e.family === FAMILY_LOCAL : e.family === FAMILY_INTERNET) && (!local || e.address === host)) ??
    candidates.find((e) => e.family === FAMILY_WILD) ??
    candidates.find((e) => e.family === FAMILY_LOCAL || e.family === FAMILY_INTERNET);
  return pick?.data ?? null;
}

function readCookie(display: X11Display): Buffer | null {
  const file = process.env.XAUTHORITY || join(homedir(), ".Xauthority");
  try {
    return cookieFor(parseXauthority(readFileSync(file)), display);
  } catch {
    return null;
  }
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

function padded(text: string | Buffer): Buffer {
  const bytes = typeof text === "string" ? Buffer.from(text, "latin1") : text;
  return Buffer.concat([bytes, Buffer.alloc(pad4(bytes.length))]);
}

/** Reads exact byte counts off a socket, in order. */
function reader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  let want: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  let failed: Error | null = null;
  const pump = () => {
    if (want && buffer.length >= want.n) {
      const out = buffer.subarray(0, want.n);
      buffer = buffer.subarray(want.n);
      const done = want;
      want = null;
      done.resolve(out);
    }
  };
  const fail = (err: Error) => {
    failed ??= err;
    want?.reject(failed);
    want = null;
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("the X server closed the connection")));
  return {
    take(n: number): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        if (failed) return reject(failed);
        want = { n, resolve, reject };
        pump();
      });
    },
  };
}

/** X11 wire constants; the client picks little-endian ('l'). */
const OP_INTERN_ATOM = 16;
const OP_GET_INPUT_FOCUS = 43;
const OP_QUERY_EXTENSION = 98;
const XFIXES_QUERY_VERSION = 0;
const XFIXES_SELECT_SELECTION_INPUT = 2;
const SET_SELECTION_OWNER_MASK = 1;
const GENERIC_EVENT = 35;

export interface SelectionWatch {
  stop(): void;
}

export interface WatchOptions {
  display?: string;
  /** How long connecting and subscribing may take. */
  timeoutMs?: number;
  /** The connection dropped after watching began. */
  onLost?: (why: string) => void;
}

/**
 * Call `onChange` whenever something takes ownership of the CLIPBOARD
 * selection -- every copy, this agent's own included. Resolves once the
 * subscription is in place; rejects when this display cannot do it (no
 * DISPLAY, no XFIXES, refused by the server).
 */
export async function watchClipboardOwner(
  onChange: () => void,
  { display = process.env.DISPLAY ?? "", timeoutMs = 5_000, onLost }: WatchOptions = {},
): Promise<SelectionWatch> {
  const target = parseDisplay(display);
  if (!target) throw new Error(`cannot read DISPLAY=${JSON.stringify(display)}`);

  const socket: Socket = target.path
    ? connect({ path: target.path })
    : connect({ host: target.host!, port: target.port! });
  let stopped = false;
  const stop = () => {
    stopped = true;
    socket.destroy();
  };
  const timer = setTimeout(() => socket.destroy(new Error("the X server did not answer in time")), timeoutMs);
  const { take } = reader(socket);

  try {
    // Connection setup.
    const cookie = readCookie(target);
    const authName = cookie ? COOKIE : "";
    const setup = Buffer.alloc(12);
    setup.write("l", 0, "latin1");
    setup.writeUInt16LE(11, 2);
    setup.writeUInt16LE(0, 4);
    setup.writeUInt16LE(authName.length, 6);
    setup.writeUInt16LE(cookie?.length ?? 0, 8);
    socket.write(Buffer.concat([setup, padded(authName), padded(cookie ?? Buffer.alloc(0))]));

    const head = await take(8);
    const body = await take(head.readUInt16LE(6) * 4);
    if (head[0] !== 1) {
      const reason = body.subarray(0, head[0] === 0 ? head[1] : body.length).toString("latin1");
      throw new Error(`the X server refused the connection: ${reason.replace(/\0+$/, "").trim()}`);
    }
    // 32 bytes of fixed fields, the vendor string, the pixmap formats, then
    // the screens; the first screen begins with its root window.
    const vendorLength = body.readUInt16LE(16);
    const formats = body[21]!;
    const root = body.readUInt32LE(32 + vendorLength + pad4(vendorLength) + formats * 8);

    // Requests are numbered from 1; replies and errors echo the number.
    const request = (bytes: Buffer) => socket.write(bytes);
    const reply = async (what: string): Promise<Buffer> => {
      const packet = await take(32);
      if (packet[0] === 0) throw new Error(`${what} failed (X error ${packet[1]})`);
      if (packet[0] === 1 && packet.readUInt32LE(4) > 0) await take(packet.readUInt32LE(4) * 4);
      return packet;
    };

    const name = "CLIPBOARD";
    const intern = Buffer.alloc(8);
    intern[0] = OP_INTERN_ATOM;
    intern.writeUInt16LE(2 + (name.length + pad4(name.length)) / 4, 2);
    intern.writeUInt16LE(name.length, 4);
    request(Buffer.concat([intern, padded(name)]));
    const clipboard = (await reply("InternAtom")).readUInt32LE(8);

    const ext = "XFIXES";
    const query = Buffer.alloc(8);
    query[0] = OP_QUERY_EXTENSION;
    query.writeUInt16LE(2 + (ext.length + pad4(ext.length)) / 4, 2);
    query.writeUInt16LE(ext.length, 4);
    request(Buffer.concat([query, padded(ext)]));
    const found = await reply("QueryExtension");
    if (!found[8]) throw new Error("this X server has no XFIXES extension");
    const major = found[9]!;
    const firstEvent = found[10]!;

    // XFixes wants its version asked before anything else of it.
    const version = Buffer.alloc(12);
    version[0] = major;
    version[1] = XFIXES_QUERY_VERSION;
    version.writeUInt16LE(3, 2);
    version.writeUInt32LE(5, 4);
    version.writeUInt32LE(0, 8);
    request(version);
    await reply("XFixesQueryVersion");

    const select = Buffer.alloc(16);
    select[0] = major;
    select[1] = XFIXES_SELECT_SELECTION_INPUT;
    select.writeUInt16LE(4, 2);
    select.writeUInt32LE(root, 4);
    select.writeUInt32LE(clipboard, 8);
    select.writeUInt32LE(SET_SELECTION_OWNER_MASK, 12);
    request(select);
    // A round trip: an error for the subscription arrives before its reply.
    const focus = Buffer.alloc(4);
    focus[0] = OP_GET_INPUT_FOCUS;
    focus.writeUInt16LE(1, 2);
    request(focus);
    await reply("XFixesSelectSelectionInput");
    clearTimeout(timer);

    void (async () => {
      try {
        for (;;) {
          const packet = await take(32);
          const code = packet[0]! & 0x7f;
          if (packet[0] === 1 || code === GENERIC_EVENT) {
            const extra = packet.readUInt32LE(4) * 4;
            if (extra) await take(extra);
            continue;
          }
          if (code === firstEvent) onChange();
        }
      } catch (err) {
        if (!stopped) onLost?.(err instanceof Error ? err.message : String(err));
      }
    })();
    return { stop };
  } catch (err) {
    clearTimeout(timer);
    stop();
    throw err;
  }
}
