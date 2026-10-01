import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiskBucket } from "../src/bucket";

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "clipsync-bucket-"));
  return { root, bucket: new DiskBucket(root) };
};

describe("DiskBucket, the R2 calls the Worker makes", () => {
  it("puts and gets bytes back, as a body and as a buffer", async () => {
    const { bucket } = fresh();
    await bucket.put("blobs/b1/0", new Uint8Array([1, 2, 3]).buffer);
    const object = await bucket.get("blobs/b1/0");
    expect(object!.size).toBe(3);
    expect([...new Uint8Array(await new Response(object!.body).arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await (await bucket.get("blobs/b1/0"))!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("answers null for a missing key", async () => {
    expect(await fresh().bucket.get("blobs/none/0")).toBeNull();
  });

  it("overwrites on a second put", async () => {
    const { bucket } = fresh();
    await bucket.put("blobs/b/0", "first");
    await bucket.put("blobs/b/0", "second");
    expect(await (await bucket.get("blobs/b/0"))!.text()).toBe("second");
  });

  it("deletes one key or many, and the blob's directory with its last chunk", async () => {
    const { root, bucket } = fresh();
    await bucket.put("blobs/b/0", "a");
    await bucket.put("blobs/b/1", "b");
    await bucket.delete("blobs/b/0");
    expect(existsSync(join(root, "blobs/b"))).toBe(true);
    await bucket.delete(["blobs/b/1", "blobs/never/0"]);
    expect(existsSync(join(root, "blobs/b"))).toBe(false);
  });

  it("refuses keys that would leave its directory", async () => {
    const { bucket } = fresh();
    await expect(bucket.put("../escape", "x")).rejects.toThrow(/invalid object key/);
    await expect(bucket.get("blobs/../../etc/passwd")).rejects.toThrow(/invalid object key/);
  });
});
