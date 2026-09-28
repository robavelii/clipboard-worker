import { describe, expect, it } from "vitest";
import { DecryptError, generateBlobKey, importBlobKey, openChunk, sealChunk, sha256Hex } from "../src/index";

const key = await importBlobKey(generateBlobKey());
const other = await importBlobKey(generateBlobKey());
const bytes = new Uint8Array([1, 2, 3, 0, 255]);

describe("blob chunks", () => {
  it("round-trip, with 28 bytes of overhead", async () => {
    const sealed = await sealChunk(key, "blob_a", 0, 2, bytes);
    expect(sealed.length).toBe(bytes.length + 28);
    expect([...(await openChunk(key, "blob_a", 0, 2, sealed))]).toEqual([...bytes]);
  });

  it("refuse another position, count, blob or key", async () => {
    const sealed = await sealChunk(key, "blob_a", 0, 2, bytes);
    for (const open of [
      () => openChunk(key, "blob_a", 1, 2, sealed),
      () => openChunk(key, "blob_a", 0, 1, sealed),
      () => openChunk(key, "blob_b", 0, 2, sealed),
      () => openChunk(other, "blob_a", 0, 2, sealed),
    ]) {
      await expect(open()).rejects.toBeInstanceOf(DecryptError);
    }
  });

  it("hashes to hex SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
