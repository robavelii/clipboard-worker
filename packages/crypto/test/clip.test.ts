import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptText,
  encryptText,
  fromBase64Url,
  generateVaultKey,
  openClip,
  peekClipHeader,
  sealClip,
  toBase64Url,
  vaultKeysFrom,
  type ClipHeader,
} from "../src/index";

const SALT = "Zm9vYmFyYmF6cXV4MTIzNA";
const keys = await vaultKeysFrom(generateVaultKey(), SALT);
const otherKeys = await vaultKeysFrom(generateVaultKey(), SALT);
const ACCOUNT = "usr_owner";
const header: ClipHeader = { device: "dev_laptop", copiedAt: 1_700_000_000_000, type: "text" };
const text = (s: string) => new TextEncoder().encode(s);

/** Re-encode an envelope's header with a change, keeping the ciphertext. */
function withHeader(envelope: string, change: Partial<{ d: string; t: number; k: string }>): string {
  const [v, h, iv, ct] = envelope.split(".");
  const wire = JSON.parse(new TextDecoder().decode(fromBase64Url(h!)));
  const edited = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...wire, ...change })));
  return [v, edited, iv, ct].join(".");
}

describe("clip envelope v2", () => {
  it("round-trips the payload and authenticates the header", async () => {
    const envelope = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    expect(envelope.startsWith("v2.")).toBe(true);
    const opened = await openClip(keys, ACCOUNT, envelope);
    expect(new TextDecoder().decode(opened.payload)).toBe("hunter2");
    expect(opened.header).toEqual(header);
  });

  it("carries binary payloads unchanged", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 0, 0, 10]);
    const opened = await openClip(keys, ACCOUNT, await sealClip(keys, ACCOUNT, header, bytes));
    expect([...opened.payload]).toEqual([...bytes]);
  });

  it("refuses a header the server rewrote", async () => {
    const envelope = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    for (const change of [{ d: "dev_phone" }, { t: Date.now() }, { k: "image" }]) {
      await expect(openClip(keys, ACCOUNT, withHeader(envelope, change))).rejects.toBeInstanceOf(
        DecryptError,
      );
    }
  });

  it("refuses an envelope moved to another account", async () => {
    const envelope = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    await expect(openClip(keys, "usr_other", envelope)).rejects.toBeInstanceOf(DecryptError);
  });

  it("refuses one clip's ciphertext under another clip's header", async () => {
    const a = (await sealClip(keys, ACCOUNT, header, text("old secret"))).split(".");
    const b = (await sealClip(keys, ACCOUNT, { ...header, copiedAt: header.copiedAt + 60_000 }, text("new"))).split(".");
    const spliced = [b[0], b[1], a[2], a[3]].join(".");
    await expect(openClip(keys, ACCOUNT, spliced)).rejects.toBeInstanceOf(DecryptError);
  });

  it("refuses the wrong key", async () => {
    const envelope = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    await expect(openClip(otherKeys, ACCOUNT, envelope)).rejects.toBeInstanceOf(DecryptError);
  });

  it("cannot be read as a v1 envelope, nor v1 as v2", async () => {
    const v2 = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    await expect(decryptText(keys, v2)).rejects.toBeInstanceOf(DecryptError);
    const v1 = await encryptText(keys, "hunter2");
    await expect(openClip(keys, ACCOUNT, v1)).rejects.toBeInstanceOf(DecryptError);
  });

  it("lets the server read the header without the key, and nothing else", async () => {
    const envelope = await sealClip(keys, ACCOUNT, header, text("hunter2"));
    expect(peekClipHeader(envelope)).toEqual(header);
    expect(envelope).not.toContain(toBase64Url(text("hunter2")));
    expect(peekClipHeader("v1.aXY.Y3Q")).toBeNull();
    expect(peekClipHeader("v2.bm90LWpzb24.aXY.Y3Q")).toBeNull();
  });
});
