/**
 * Two accounts on one server: neither sees, reaches or deletes the other's
 * data. The first comes from `bootstrap`, as on a real server; the second is
 * written straight into the database, since signup does not exist yet.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Clip, Credentials, ListClipsResponse, PairCodeResponse, WhoAmI } from "@clipsync/protocol";
import { sha256 } from "../src/ids";
import { api, bootstrap, v2Envelope } from "./helpers";

const MiB = 1024 * 1024;

/** A second account with one device, as signup will make it. */
async function secondAccount(): Promise<Credentials> {
  const userId = `usr_b${crypto.randomUUID().slice(0, 8)}`;
  const deviceId = `dev_b${crypto.randomUUID().slice(0, 8)}`;
  const token = `tok_b${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, kdf_salt, wrapped_vault_key, created_at) VALUES (?, ?, ?, ?)",
    ).bind(userId, "salt-of-b", "k1.wrapped-for-b", Date.now() + 1),
    env.DB.prepare(
      "INSERT INTO devices (id, user_id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(deviceId, userId, "b-laptop", "linux", await sha256(token), Date.now()),
  ]);
  return { userId, deviceId, token, kdfSalt: "salt-of-b", wrappedVaultKey: "k1.wrapped-for-b", keyEpoch: 0 };
}

async function textClip(who: Credentials, hash = `h-${Math.random()}`): Promise<string> {
  const res = await api("/api/clips", {
    method: "POST",
    token: who.token,
    body: { type: "text", envelope: v2Envelope(who.deviceId), contentHash: hash, size: 1, keyEpoch: 0 },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function fileClip(who: Credentials, sizes: number[]): Promise<string> {
  const reserve = await api("/api/blobs", {
    method: "POST",
    token: who.token,
    body: { chunks: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) },
  });
  expect(reserve.status).toBe(200);
  const { id: blobId } = (await reserve.json()) as { id: string };
  for (const [i, size] of sizes.entries()) {
    const put = await api(`/api/blobs/${blobId}/${i}`, { method: "PUT", token: who.token, raw: new Uint8Array(size) });
    expect(put.status).toBe(200);
  }
  const res = await api("/api/clips", {
    method: "POST",
    token: who.token,
    body: {
      type: "file",
      envelope: v2Envelope(who.deviceId, "file"),
      contentHash: `f-${Math.random()}`,
      size: 1,
      keyEpoch: 0,
      blobId,
    },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

describe("two accounts on one server", () => {
  it("each device is told its own account's salt and wrapped key", async () => {
    const a = await bootstrap("a-laptop");
    const b = await secondAccount();

    const meB = (await (await api("/api/auth/me", { token: b.token })).json()) as WhoAmI;
    expect(meB).toMatchObject({ userId: b.userId, kdfSalt: "salt-of-b", wrappedVaultKey: "k1.wrapped-for-b" });
    const keyB = await (await api("/api/vault/key", { token: b.token })).json();
    expect(keyB).toMatchObject({ kdfSalt: "salt-of-b", wrappedVaultKey: "k1.wrapped-for-b" });

    const meA = (await (await api("/api/auth/me", { token: a.token })).json()) as WhoAmI;
    expect(meA.userId).toBe(a.userId);
    expect(meA.kdfSalt).not.toBe("salt-of-b");
  });

  it("a pairing code enrols into the account that minted it, with that account's salt", async () => {
    await bootstrap("a-laptop");
    const b = await secondAccount();
    const { code } = (await (await api("/api/devices/pair-code", { method: "POST", token: b.token })).json()) as PairCodeResponse;
    const paired = (await (
      await api("/api/devices/pair", { method: "POST", body: { code, deviceName: "b-phone", platform: "android" } })
    ).json()) as Credentials;
    expect(paired).toMatchObject({ userId: b.userId, kdfSalt: "salt-of-b", wrappedVaultKey: "k1.wrapped-for-b" });
  });

  it("neither lists, reads, pins, deletes nor revokes what the other holds", async () => {
    const a = await bootstrap("a-laptop");
    const b = await secondAccount();
    const clipA = await textClip(a);
    await textClip(b);

    const listB = (await (await api("/api/clips", { token: b.token })).json()) as ListClipsResponse;
    expect(listB.clips.map((c: Clip) => c.id)).not.toContain(clipA);
    expect((await api(`/api/clips/${clipA}`, { token: b.token })).status).toBe(404);
    expect(
      (await api(`/api/clips/${clipA}/pin`, { method: "POST", token: b.token, body: { pinned: true } })).status,
    ).toBe(404);
    await api(`/api/clips/${clipA}`, { method: "DELETE", token: b.token });
    expect((await api(`/api/clips/${clipA}`, { token: a.token })).status).toBe(200);

    expect((await api(`/api/devices/${a.deviceId}`, { method: "DELETE", token: b.token })).status).toBe(404);
    expect((await api("/api/auth/me", { token: a.token })).status).toBe(200);
  });

  it("an upload makes room only from its own account's files", async () => {
    const a = await bootstrap("a-laptop");
    const b = await secondAccount();
    // A holds 2 of the 3 MiB the tests allow.
    const fileA = await fileClip(a, [MiB, MiB]);

    // B has nothing of its own to evict, so it is refused, and A keeps its file.
    const refused = await api("/api/blobs", { method: "POST", token: b.token, body: { chunks: 2, bytes: 2 * MiB } });
    expect(refused.status).toBe(429);
    expect((await api(`/api/clips/${fileA}`, { token: a.token })).status).toBe(200);

    // A, uploading as much again, evicts its own older file.
    await fileClip(a, [MiB, MiB]);
    expect((await api(`/api/clips/${fileA}`, { token: a.token })).status).toBe(404);
  });
});
