import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptText,
  dedupeHash,
  deriveKeys,
  encryptText,
  fromBase64Url,
  randomSalt,
  toBase64Url,
} from "../src/index";

const SALT = "Zm9vYmFyYmF6cXV4MTIzNA";
const PASSPHRASE = "correct horse battery staple";

// Key derivation is deliberately expensive; derive once and share.
const keys = await deriveKeys(PASSPHRASE, SALT);

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 62, 63, 127, 128, 254, 255]);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  it("emits no padding or url-unsafe characters", () => {
    for (let len = 1; len <= 8; len++) {
      const encoded = toBase64Url(new Uint8Array(len).fill(255));
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe("envelopes", () => {
  it("round-trips text", async () => {
    const text = "docker compose up -d";
    expect(await decryptText(keys, await encryptText(keys, text))).toBe(text);
  });

  it("round-trips unicode and newlines", async () => {
    const text = "héllo\n🌍\ttabs — em-dash\r\nend";
    expect(await decryptText(keys, await encryptText(keys, text))).toBe(text);
  });

  it("round-trips a large payload", async () => {
    const text = "x".repeat(100_000);
    expect(await decryptText(keys, await encryptText(keys, text))).toBe(text);
  });

  it("uses a fresh IV per encryption", async () => {
    const a = await encryptText(keys, "same");
    const b = await encryptText(keys, "same");
    expect(a).not.toBe(b);
    expect(await decryptText(keys, a)).toBe(await decryptText(keys, b));
  });

  it("produces the documented v1 format", async () => {
    const parts = (await encryptText(keys, "hi")).split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
  });

  it("rejects a wrong passphrase", async () => {
    const envelope = await encryptText(keys, "secret");
    const wrong = await deriveKeys("not the passphrase", SALT);
    await expect(decryptText(wrong, envelope)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("rejects the right passphrase under a different salt", async () => {
    const envelope = await encryptText(keys, "secret");
    const otherSalt = await deriveKeys(PASSPHRASE, randomSalt());
    await expect(decryptText(otherSalt, envelope)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("rejects a tampered ciphertext", async () => {
    const [, iv, ct] = (await encryptText(keys, "secret")).split(".");
    const bytes = fromBase64Url(ct!);
    bytes[0] ^= 0xff;
    await expect(
      decryptText(keys, `v1.${iv}.${toBase64Url(bytes)}`),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a malformed envelope", async () => {
    await expect(decryptText(keys, "not-an-envelope")).rejects.toBeInstanceOf(
      DecryptError,
    );
    await expect(decryptText(keys, "v2.aaaa.bbbb")).rejects.toBeInstanceOf(
      DecryptError,
    );
  });
});

describe("dedupe tags", () => {
  it("is stable for identical input", async () => {
    expect(await dedupeHash(keys, "npm install hono")).toBe(
      await dedupeHash(keys, "npm install hono"),
    );
  });

  it("differs for different input", async () => {
    expect(await dedupeHash(keys, "a")).not.toBe(await dedupeHash(keys, "b"));
  });

  /**
   * The point of using an HMAC rather than a bare digest: two users -- or an
   * attacker holding the database -- cannot confirm a guess at the content.
   */
  it("differs across passphrases for the same plaintext", async () => {
    const other = await deriveKeys("a different passphrase", SALT);
    expect(await dedupeHash(keys, "shared text")).not.toBe(
      await dedupeHash(other, "shared text"),
    );
  });
});
