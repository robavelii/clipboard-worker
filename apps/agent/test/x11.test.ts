import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFor, parseDisplay, parseXauthority, watchClipboardOwner } from "../src/x11";

describe("DISPLAY", () => {
  it("names the local socket, a socket path, or a TCP port", () => {
    expect(parseDisplay(":0")).toEqual({ path: "/tmp/.X11-unix/X0", number: "0" });
    expect(parseDisplay(":1.0")).toEqual({ path: "/tmp/.X11-unix/X1", number: "1" });
    expect(parseDisplay("unix:2")).toEqual({ path: "/tmp/.X11-unix/X2", number: "2" });
    expect(parseDisplay("/private/tmp/com.apple.launchd.x/org.xquartz:0")).toEqual({
      path: "/private/tmp/com.apple.launchd.x/org.xquartz:0",
      number: "0",
    });
    expect(parseDisplay("localhost:10.0")).toEqual({ host: "localhost", port: 6010, number: "10" });
    expect(parseDisplay("")).toBeNull();
    expect(parseDisplay("nonsense")).toBeNull();
  });
});

/** One Xauthority record, as xauth writes it. */
function record(family: number, address: string, number: string, name: string, data: Buffer): Buffer {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const head = Buffer.alloc(2);
  head.writeUInt16BE(family);
  return Buffer.concat([
    head,
    field(Buffer.from(address)),
    field(Buffer.from(number)),
    field(Buffer.from(name)),
    field(data),
  ]);
}

describe("Xauthority", () => {
  const mine = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const other = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  const file = Buffer.concat([
    record(256, "otherhost", "0", "MIT-MAGIC-COOKIE-1", other),
    record(256, "thishost", "1", "MIT-MAGIC-COOKIE-1", other),
    record(256, "thishost", "0", "MIT-MAGIC-COOKIE-1", mine),
    record(256, "thishost", "0", "XDM-AUTHORIZATION-1", other),
  ]);

  it("parses every record, and keeps the whole ones of a truncated file", () => {
    expect(parseXauthority(file)).toHaveLength(4);
    expect(parseXauthority(file.subarray(0, file.length - 3))).toHaveLength(3);
  });

  it("picks this host's cookie for the display", () => {
    const entries = parseXauthority(file);
    expect(cookieFor(entries, parseDisplay(":0")!, "thishost")).toEqual(mine);
    expect(cookieFor(entries, parseDisplay(":1")!, "thishost")).toEqual(other);
    expect(cookieFor(entries, parseDisplay(":7")!, "thishost")).toBeNull();
  });

  it("falls back to a wildcard entry", () => {
    const wild = parseXauthority(record(65535, "", "", "MIT-MAGIC-COOKIE-1", mine));
    expect(cookieFor(wild, parseDisplay(":3")!, "anyhost")).toEqual(mine);
  });
});

const has = (tool: string) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// A real X server: Xvfb, where installed.
describe.skipIf(!has("Xvfb") || !has("xclip"))("XFixes clipboard events", () => {
  const servers: ChildProcess[] = [];
  let dir: string;

  /** An Xvfb on a free display, with the given cookie file if any. */
  const startX = async (args: string[] = []): Promise<string> => {
    for (let n = 80 + Math.floor(Math.random() * 100); ; n++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
      servers.push(spawn("Xvfb", [`:${n}`, "-nolisten", "tcp", ...args], { stdio: "ignore" }));
      for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return `:${n}`;
    }
  };

  const copy = (display: string, selection: string, text: string, env: NodeJS.ProcessEnv = {}) =>
    execFileSync("xclip", ["-selection", selection, "-i"], {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, ...env, DISPLAY: display },
    });

  const settle = () => new Promise((r) => setTimeout(r, 300));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clipsync-x11-"));
  });
  afterAll(() => {
    for (const server of servers) server.kill();
  });

  it("announces every copy to the clipboard, and nothing else", async () => {
    const display = await startX();
    let changes = 0;
    const watch = await watchClipboardOwner(() => changes++, { display });
    try {
      copy(display, "clipboard", "one");
      await settle();
      copy(display, "clipboard", "two");
      await settle();
      copy(display, "primary", "a selection, not a copy");
      await settle();
      expect(changes).toBe(2);
    } finally {
      watch.stop();
    }
  });

  it("authenticates with the display's cookie", async () => {
    const cookie = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const auth = join(dir, "Xauthority");
    await writeFile(auth, record(65535, "", "", "MIT-MAGIC-COOKIE-1", cookie));
    const display = await startX(["-auth", auth]);

    const saved = process.env.XAUTHORITY;
    process.env.XAUTHORITY = auth;
    try {
      let changes = 0;
      const watch = await watchClipboardOwner(() => changes++, { display });
      copy(display, "clipboard", "with a cookie", { XAUTHORITY: auth });
      await settle();
      watch.stop();
      expect(changes).toBe(1);

      // Without it, the server says no, and the agent polls instead.
      process.env.XAUTHORITY = join(dir, "missing");
      await expect(watchClipboardOwner(() => undefined, { display })).rejects.toThrow(/refused/);
    } finally {
      if (saved === undefined) delete process.env.XAUTHORITY;
      else process.env.XAUTHORITY = saved;
    }
  });

  it("says when the server goes away", async () => {
    const display = await startX();
    const lost = new Promise<string>((resolve) => {
      void watchClipboardOwner(() => undefined, { display, onLost: resolve }).then(() =>
        servers.at(-1)!.kill(),
      );
    });
    expect(await lost).toMatch(/closed|ECONNRESET/);
  });

  it("cannot watch a display that is not there", async () => {
    await expect(watchClipboardOwner(() => undefined, { display: ":987" })).rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });
});
