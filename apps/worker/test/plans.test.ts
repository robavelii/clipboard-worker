/**
 * Per-account plans (decisions §44): each limit a plan sets, enforced at the
 * place it applies, with the Worker's own budgets still the outer guard. An
 * account is moved to a plan the way an operator would, with an UPDATE.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BlobUsageResponse, Clip, Credentials, PairCodeResponse } from "@clipsync/protocol";
import { api, bootstrap, v2Envelope } from "./helpers";

const MiB = 1024 * 1024;
const month = new Date().toISOString().slice(0, 7);

async function onPlan(who: Credentials, plan: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(plan, who.userId).run();
}

async function pairDevice(who: Credentials, name: string): Promise<Response> {
  const { code } = (await (await api("/api/devices/pair-code", { method: "POST", token: who.token })).json()) as PairCodeResponse;
  return api("/api/devices/pair", { method: "POST", body: { code, deviceName: name, platform: "linux" } });
}

async function reserve(who: Credentials, bytes: number): Promise<Response> {
  return api("/api/blobs", { method: "POST", token: who.token, body: { chunks: Math.ceil(bytes / MiB), bytes } });
}

async function fileClip(who: Credentials, type: "image" | "file", sizes: number[]): Promise<Response> {
  const res = await reserve(who, sizes.reduce((a, b) => a + b, 0));
  expect(res.status).toBe(200);
  const { id: blobId } = (await res.json()) as { id: string };
  for (const [i, size] of sizes.entries()) {
    expect((await api(`/api/blobs/${blobId}/${i}`, { method: "PUT", token: who.token, raw: new Uint8Array(size) })).status).toBe(200);
  }
  return api("/api/clips", {
    method: "POST",
    token: who.token,
    body: { type, envelope: v2Envelope(who.deviceId, type), contentHash: `f-${Math.random()}`, size: 1, keyEpoch: 0, blobId },
  });
}

async function accountUsage(who: Credentials) {
  return ((await (await api("/api/blobs/usage", { token: who.token })).json()) as BlobUsageResponse).account!;
}

describe("plans", () => {
  it("leaves existing accounts unlimited", async () => {
    const owner = await bootstrap("owner");
    expect(await accountUsage(owner)).toMatchObject({ plan: "unlimited", storageBytes: null, classABudget: null });
  });

  it("caps devices, and frees a place when one is revoked", async () => {
    const owner = await bootstrap("owner");
    await onPlan(owner, "free");
    expect((await pairDevice(owner, "second")).status).toBe(200);
    const third = (await (await pairDevice(owner, "third")).json()) as Credentials;

    const fourth = await pairDevice(owner, "fourth");
    expect(fourth.status).toBe(403);
    expect(((await fourth.json()) as { message: string }).message).toMatch(/no room for another device/);

    expect((await api(`/api/devices/${third.deviceId}`, { method: "DELETE", token: owner.token })).status).toBe(200);
    expect((await pairDevice(owner, "fourth")).status).toBe(200);
  });

  it("keeps clips for the plan's days, and syncs images but not other files", async () => {
    const owner = await bootstrap("owner");
    await onPlan(owner, "free");
    const text = await api("/api/clips", {
      method: "POST",
      token: owner.token,
      body: { type: "text", envelope: v2Envelope(owner.deviceId), contentHash: "t", size: 1, keyEpoch: 0 },
    });
    const { id } = (await text.json()) as { id: string };
    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    expect((clip.expiresAt! - clip.createdAt) / 86_400_000).toBe(7);

    expect((await fileClip(owner, "image", [100])).status).toBe(200);
    const file = await fileClip(owner, "file", [100]);
    expect(file.status).toBe(403);
  });

  it("refuses a file at reservation, before the upload, when the client says what it is for", async () => {
    const owner = await bootstrap("owner");
    await onPlan(owner, "free");
    const asFile = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 1, bytes: 100, type: "file" } });
    expect(asFile.status).toBe(403);
    const asImage = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 1, bytes: 100, type: "image" } });
    expect(asImage.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("holds an account to its storage quota, evicting only its own files", async () => {
    const owner = await bootstrap("owner");
    await onPlan(owner, "free");
    await env.DB.prepare("UPDATE plans SET storage_bytes = ? WHERE name = 'free'").bind(1.5 * MiB).run();

    expect((await reserve(owner, 2 * MiB)).status).toBe(429);
    const first = (await (await fileClip(owner, "image", [MiB])).json()) as { id: string };
    // Another MiB fits only once the first image goes.
    expect((await fileClip(owner, "image", [MiB])).status).toBe(200);
    expect((await api(`/api/clips/${first.id}`, { token: owner.token })).status).toBe(404);
    expect((await accountUsage(owner)).storedBytes).toBe(MiB);
  });

  it("counts R2 operations per account, beside the server's count", async () => {
    const owner = await bootstrap("owner");
    await onPlan(owner, "free");
    await env.DB.prepare("UPDATE plans SET class_a = 2 WHERE name = 'free'").run();

    const res = await api("/api/blobs", { method: "POST", token: owner.token, body: { chunks: 3, bytes: 300 } });
    const { id } = (await res.json()) as { id: string };
    const put = (idx: number) => api(`/api/blobs/${id}/${idx}`, { method: "PUT", token: owner.token, raw: new Uint8Array(100) });
    expect((await put(0)).status).toBe(200);
    expect((await put(1)).status).toBe(200);
    const third = await put(2);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "r2_budget" });

    expect(await accountUsage(owner)).toMatchObject({ classA: 2, classABudget: 2 });
    const server = await env.DB.prepare("SELECT class_a FROM r2_usage WHERE month = ?").bind(month).first<{ class_a: number }>();
    expect(server?.class_a).toBe(2);
  });

  it("moves neither count when the server's budget is spent", async () => {
    const owner = await bootstrap("owner");
    await env.DB.prepare("INSERT INTO r2_usage (month, class_a) VALUES (?, 40)").bind(month).run();

    const { id } = (await (await reserve(owner, 100)).json()) as { id: string };
    const put = await api(`/api/blobs/${id}/0`, { method: "PUT", token: owner.token, raw: new Uint8Array(100) });
    expect(put.status).toBe(429);
    expect((await accountUsage(owner)).classA).toBe(0);
  });
});
