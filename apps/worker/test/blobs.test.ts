import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BlobUsageResponse, Clip } from "@clipsync/protocol";
import worker from "../src/index";
import { api, bootstrap, v2Envelope } from "./helpers";

const MiB = 1024 * 1024;
const month = new Date().toISOString().slice(0, 7);

async function blobUpload(token: string, sizes: number[]): Promise<string> {
  const res = await api("/api/blobs", {
    method: "POST",
    token,
    body: { chunks: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) },
  });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  for (const [i, size] of sizes.entries()) {
    const put = await putChunk(token, id, i, size);
    expect(put.status).toBe(200);
  }
  return id;
}

function putChunk(token: string, id: string, idx: number, size: number, fill = idx + 1) {
  return api(`/api/blobs/${id}/${idx}`, { method: "PUT", token, raw: new Uint8Array(size).fill(fill) });
}

async function fileClip(
  token: string,
  deviceId: string,
  blobId: string,
  { type = "file", hash = `h-${Math.random()}` }: { type?: string; hash?: string } = {},
) {
  return api("/api/clips", {
    method: "POST",
    token,
    body: { type, envelope: v2Envelope(deviceId, type), contentHash: hash, size: 1, keyEpoch: 0, blobId },
  });
}

async function objects(): Promise<string[]> {
  return (await env.BLOBS.list()).objects.map((o) => o.key).sort();
}

async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("blob upload", () => {
  it("stores chunks, lets a clip adopt them, and serves them back", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100, 60]);
    const created = await fileClip(owner.token, owner.deviceId, blobId, { type: "image" });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };

    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    expect(clip).toMatchObject({ type: "image", blobId });

    const chunk = await api(`/api/blobs/${blobId}/1`, { token: owner.token });
    expect(new Uint8Array(await chunk.arrayBuffer())).toEqual(new Uint8Array(60).fill(2));
    expect(await objects()).toEqual([`blobs/${blobId}/0`, `blobs/${blobId}/1`]);
  });

  it("deletes a clip's R2 objects with the clip", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100]);
    const { id } = (await (await fileClip(owner.token, owner.deviceId, blobId)).json()) as { id: string };
    expect((await api(`/api/clips/${id}`, { method: "DELETE", token: owner.token })).status).toBe(200);
    expect(await objects()).toEqual([]);
  });

  it("refuses a clip over an incomplete blob, or a blob with the wrong clip", async () => {
    const owner = await bootstrap("owner");
    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 2, bytes: 200 } });
    const { id } = (await res.json()) as { id: string };
    await putChunk(owner.token, id, 0, 100);
    expect((await fileClip(owner.token, owner.deviceId, id)).status).toBe(409);

    // Text carries no blob; images and files need one, and a v2 envelope.
    const text = await api("/api/clips", {
      method: "POST",
      token: owner.token,
      body: { type: "text", envelope: v2Envelope(owner.deviceId), contentHash: "t", size: 1, blobId: id },
    });
    expect(text.status).toBe(400);
    const noBlob = await api("/api/clips", {
      method: "POST",
      token: owner.token,
      body: { type: "file", envelope: v2Envelope(owner.deviceId, "file"), contentHash: "f", size: 1 },
    });
    expect(noBlob.status).toBe(400);
  });

  it("keeps another account's device away from the blob", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100]);
    // Same account, other device: fine. A made-up blob id: not found.
    const phone = await bootstrap("phone");
    expect((await api(`/api/blobs/${blobId}/0`, { token: phone.token })).status).toBe(200);
    expect((await api(`/api/blobs/blob_nope/0`, { token: phone.token })).status).toBe(404);
  });

  it("refuses chunks beyond the declared size, and uploads to an adopted blob", async () => {
    const owner = await bootstrap("owner");
    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 1, bytes: 100 } });
    const { id } = (await res.json()) as { id: string };
    expect((await putChunk(owner.token, id, 0, 101)).status).toBe(400);
    expect((await putChunk(owner.token, id, 1, 50)).status).toBe(400);
    expect((await putChunk(owner.token, id, 0, 100)).status).toBe(200);
    await fileClip(owner.token, owner.deviceId, id);
    expect((await putChunk(owner.token, id, 0, 100)).status).toBe(409);
  });
});

describe("the R2 budget", () => {
  it("refuses uploads once the month's Class A budget is spent", async () => {
    const owner = await bootstrap("owner");
    await env.DB.prepare("INSERT INTO r2_usage (month, class_a, class_b) VALUES (?, 40, 0)").bind(month).run();
    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 1, bytes: 100 } });
    const { id } = (await res.json()) as { id: string };
    const put = await putChunk(owner.token, id, 0, 100);
    expect(put.status).toBe(429);
    expect(await put.json()).toMatchObject({ error: "r2_budget" });
    expect(await objects()).toEqual([]);
  });

  it("refuses downloads once the month's Class B budget is spent", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100]);
    await env.DB.prepare("UPDATE r2_usage SET class_b = 40 WHERE month = ?").bind(month).run();
    const get = await api(`/api/blobs/${blobId}/0`, { token: owner.token });
    expect(get.status).toBe(429);
  });

  it("counts operations and reports them", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100, 100]);
    await api(`/api/blobs/${blobId}/0`, { token: owner.token });
    const usage = (await (await api("/api/blobs/usage", { token: owner.token })).json()) as BlobUsageResponse;
    expect(usage).toMatchObject({ month, classA: 2, classB: 1, storedBytes: 200, storageBudgetBytes: 3 * MiB });
  });

  it("makes room by deleting the oldest unpinned files", async () => {
    const owner = await bootstrap("owner");
    const first = await blobUpload(owner.token, [MiB, MiB]);
    const { id: firstClip } = (await (await fileClip(owner.token, owner.deviceId, first)).json()) as { id: string };

    // 2 MiB held; another 2 MiB does not fit under 3 MiB without evicting.
    const second = await blobUpload(owner.token, [MiB, MiB]);
    expect((await api(`/api/clips/${firstClip}`, { token: owner.token })).status).toBe(404);
    expect(await objects()).toEqual([`blobs/${second}/0`, `blobs/${second}/1`]);
  });

  it("never evicts a pinned file, and refuses instead", async () => {
    const owner = await bootstrap("owner");
    const first = await blobUpload(owner.token, [MiB, MiB]);
    const { id } = (await (await fileClip(owner.token, owner.deviceId, first)).json()) as { id: string };
    await api(`/api/clips/${id}/pin`, { method: "POST", token: owner.token, body: { pinned: true } });

    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 2, bytes: 2 * MiB } });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "r2_budget" });
    expect((await api(`/api/clips/${id}`, { token: owner.token })).status).toBe(200);
  });

  it("refuses a file larger than the whole storage budget", async () => {
    const owner = await bootstrap("owner");
    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 4, bytes: 4 * MiB } });
    expect(res.status).toBe(429);
  });
});

describe("expiry and dedupe for files", () => {
  it("gives files a shorter life, and the cron deletes their objects and abandoned uploads", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100]);
    const { id } = (await (await fileClip(owner.token, owner.deviceId, blobId)).json()) as { id: string };
    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    const days = (clip.expiresAt! - clip.createdAt) / 86_400_000;
    expect(days).toBe(7);

    const abandoned = await blobUpload(owner.token, [100]);
    await env.DB.batch([
      env.DB.prepare("UPDATE clips SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id),
      env.DB.prepare("UPDATE blobs SET created_at = ? WHERE id = ?").bind(Date.now() - 2 * 3600_000, abandoned),
    ]);
    await runCron();
    expect(await objects()).toEqual([]);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("moves a re-copied file to the new blob and drops the old one", async () => {
    const owner = await bootstrap("owner");
    const first = await blobUpload(owner.token, [100]);
    const { id } = (await (await fileClip(owner.token, owner.deviceId, first, { hash: "same" })).json()) as { id: string };
    await api("/api/clips", {
      method: "POST",
      token: owner.token,
      body: { type: "text", envelope: v2Envelope(owner.deviceId), contentHash: "other", size: 1, keyEpoch: 0 },
    });

    const second = await blobUpload(owner.token, [100]);
    const bump = (await (await fileClip(owner.token, owner.deviceId, second, { hash: "same" })).json()) as { id: string; deduped: boolean };
    expect(bump).toMatchObject({ id, deduped: true });
    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    expect(clip.blobId).toBe(second);
    expect(await objects()).toEqual([`blobs/${second}/0`]);

    // A repeat of the newest clip keeps what is stored and drops the upload.
    const third = await blobUpload(owner.token, [100]);
    await fileClip(owner.token, owner.deviceId, third, { hash: "same" });
    expect(await objects()).toEqual([`blobs/${second}/0`]);
  });

  it("re-encrypts a file clip's envelope only as its own type", async () => {
    const owner = await bootstrap("owner");
    const blobId = await blobUpload(owner.token, [100]);
    const { id } = (await (await fileClip(owner.token, owner.deviceId, blobId, { type: "image" })).json()) as { id: string };
    await api("/api/vault/key", { method: "PUT", token: owner.token, body: { wrappedVaultKey: "k1.aXY.Y3Q", authHash: "A".repeat(43) } });
    await env.DB.prepare("UPDATE users SET key_epoch = 1").run();

    const reencrypt = (type: string) =>
      api("/api/clips/reencrypt", {
        method: "POST",
        token: owner.token,
        body: { items: [{ id, fromEpoch: 0, envelope: v2Envelope(owner.deviceId, type), contentHash: "n" }] },
      }).then((r) => r.json());
    expect(await reencrypt("file")).toMatchObject({ updated: 0 });
    expect(await reencrypt("image")).toMatchObject({ updated: 1 });
  });
});
