import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHashOf } from "@clipsync/crypto";
import type {
  Clip,
  Credentials,
  Device,
  ListClipsResponse,
  RotateVaultResponse,
  SealedVaultKeyResponse,
  VaultKeyResponse,
} from "@clipsync/protocol";
import { api, bootstrap } from "./helpers";

const WRAPPED = "k1.aXYtaXYtaXYtaXY.Y2lwaGVydGV4dA";
const WRAPPED_2 = "k1.b3RoZXItaXYtaXY.bmV3LWNpcGhlcnRleHQ";
const PROOF = "b3duZXItcHJvb2Ytb3duZXItcHJvb2Ytb3duZXItcHI";
const PUBLIC_KEY = `B${"Q".repeat(86)}`;

/** Two devices on an account whose key is wrapped under PROOF's passphrase. */
async function account() {
  const owner = await bootstrap("owner");
  const phone = await bootstrap("phone");
  const put = await api("/api/vault/key", {
    method: "PUT",
    token: owner.token,
    body: { wrappedVaultKey: WRAPPED, authHash: await authHashOf(PROOF) },
  });
  expect(put.status).toBe(200);
  return { owner, phone };
}

async function rotate(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return api("/api/vault/rotate", {
    method: "POST",
    token,
    body: {
      fromEpoch: 0,
      authProof: PROOF,
      authHash: await authHashOf(PROOF),
      wrappedVaultKey: WRAPPED_2,
      sealedKeys: [],
      ...overrides,
    },
  });
}

async function createClip(token: string, keyEpoch?: number, tag = "x") {
  return api("/api/clips", {
    method: "POST",
    token,
    body: {
      type: "text",
      envelope: `v1.aXYtaXYtaXYtaXY.${tag}`,
      contentHash: `hash-${tag}-${Math.random()}`,
      size: 1,
      ...(keyEpoch === undefined ? {} : { keyEpoch }),
    },
  });
}

describe("device keys", () => {
  it("registers this device's public key and lists it", async () => {
    const { owner } = await account();
    const put = await api("/api/devices/me/key", {
      method: "PUT",
      token: owner.token,
      body: { publicKey: PUBLIC_KEY },
    });
    expect(put.status).toBe(200);

    const { devices } = (await (
      await api("/api/devices", { token: owner.token })
    ).json()) as { devices: Device[] };
    expect(devices.find((d) => d.id === owner.deviceId)?.publicKey).toBe(PUBLIC_KEY);
  });

  it("refuses a malformed public key", async () => {
    const { owner } = await account();
    const res = await api("/api/devices/me/key", {
      method: "PUT",
      token: owner.token,
      body: { publicKey: "not a key" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/vault/rotate", () => {
  it("reports the epoch everywhere a device learns about the vault", async () => {
    const { owner } = await account();
    const key = (await (await api("/api/vault/key", { token: owner.token })).json()) as VaultKeyResponse;
    expect(key.keyEpoch).toBe(0);
    const me = (await (await api("/api/auth/me", { token: owner.token })).json()) as { keyEpoch: number };
    expect(me.keyEpoch).toBe(0);
    const creds: Credentials = await bootstrap("third");
    expect(creds.keyEpoch).toBe(0);
  });

  it("moves to the next epoch and hands each sealed copy to its device", async () => {
    const { owner, phone } = await account();
    const res = await rotate(owner.token, {
      sealedKeys: [{ deviceId: phone.deviceId, sealed: "d1.eph.iv.for-phone" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RotateVaultResponse;
    expect(body.epoch).toBe(1);
    expect(body.unsealed).toEqual([owner.deviceId]);

    const key = (await (await api("/api/vault/key", { token: owner.token })).json()) as VaultKeyResponse;
    expect(key).toMatchObject({ keyEpoch: 1, wrappedVaultKey: WRAPPED_2 });

    const forPhone = (await (
      await api("/api/vault/sealed", { token: phone.token })
    ).json()) as SealedVaultKeyResponse;
    expect(forPhone).toEqual({ epoch: 1, sealed: "d1.eph.iv.for-phone" });

    const forOwner = (await (
      await api("/api/vault/sealed", { token: owner.token })
    ).json()) as SealedVaultKeyResponse;
    expect(forOwner).toEqual({ epoch: 1, sealed: null });
  });

  it("requires the current passphrase", async () => {
    const { owner, phone } = await account();
    const res = await rotate(phone.token, {
      authProof: "b3RoZXItcHJvb2Ytb3RoZXItcHJvb2Ytb3RoZXItcHI",
    });
    expect(res.status).toBe(403);
    const key = (await (await api("/api/vault/key", { token: owner.token })).json()) as VaultKeyResponse;
    expect(key.keyEpoch).toBe(0);
  });

  it("refuses to rotate from an epoch the account has left", async () => {
    const { owner } = await account();
    expect((await rotate(owner.token)).status).toBe(200);
    // A second re-key racing the first.
    expect((await rotate(owner.token)).status).toBe(409);
  });

  it("refuses sealed copies for devices that are revoked or not the account's", async () => {
    const { owner, phone } = await account();
    await api(`/api/devices/${phone.deviceId}`, { method: "DELETE", token: owner.token });

    const toRevoked = await rotate(owner.token, {
      sealedKeys: [{ deviceId: phone.deviceId, sealed: "d1.a.b.c" }],
    });
    expect(toRevoked.status).toBe(400);
    const toStranger = await rotate(owner.token, {
      sealedKeys: [{ deviceId: "dev_nobody", sealed: "d1.a.b.c" }],
    });
    expect(toStranger.status).toBe(400);
  });

  it("does not list a revoked device as needing a key", async () => {
    const { owner, phone } = await account();
    await api(`/api/devices/${phone.deviceId}`, { method: "DELETE", token: owner.token });
    const body = (await (await rotate(owner.token)).json()) as RotateVaultResponse;
    expect(body.unsealed).toEqual([owner.deviceId]);
  });
});

describe("writing clips across a re-key", () => {
  it("accepts clips without an epoch while the account is on epoch 0", async () => {
    const { owner } = await account();
    expect((await createClip(owner.token)).status).toBe(200);
  });

  it("refuses a clip under a retired key, and accepts the new one", async () => {
    const { owner } = await account();
    await rotate(owner.token);

    const stale = await createClip(owner.token, 0, "stale");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_epoch" });
    expect((await createClip(owner.token, undefined, "old-client")).status).toBe(409);

    const fresh = await createClip(owner.token, 1, "fresh");
    expect(fresh.status).toBe(200);
    const { clips } = (await (
      await api("/api/clips", { token: owner.token })
    ).json()) as ListClipsResponse;
    expect(clips[0]?.keyEpoch).toBe(1);
  });
});

describe("POST /api/clips/reencrypt", () => {
  async function withOldClip() {
    const { owner, phone } = await account();
    const created = (await (await createClip(owner.token, 0, "old")).json()) as { id: string };
    await rotate(owner.token);
    return { owner, phone, id: created.id };
  }

  it("lists clips still under a retired key", async () => {
    const { owner, id } = await withOldClip();
    await createClip(owner.token, 1, "new");
    const { clips } = (await (
      await api("/api/clips?epochBelow=1", { token: owner.token })
    ).json()) as ListClipsResponse;
    expect(clips.map((c) => c.id)).toEqual([id]);
  });

  it("moves a clip to the current key, once", async () => {
    const { owner, id } = await withOldClip();
    const item = { id, fromEpoch: 0, envelope: "v1.bmV3LWl2LW5ldy1pdg.cmVrZXllZA", contentHash: "new-hash" };
    const first = await api("/api/clips/reencrypt", {
      method: "POST",
      token: owner.token,
      body: { items: [item] },
    });
    expect(await first.json()).toEqual({ updated: 1, epoch: 1 });

    const clip = (await (await api(`/api/clips/${id}`, { token: owner.token })).json()) as Clip;
    expect(clip).toMatchObject({ keyEpoch: 1, envelope: item.envelope, contentHash: "new-hash" });

    // Replayed, or raced by another device: the clip is no longer at epoch 0.
    const again = await api("/api/clips/reencrypt", {
      method: "POST",
      token: owner.token,
      body: { items: [item] },
    });
    expect(await again.json()).toEqual({ updated: 0, epoch: 1 });

    const left = (await (
      await api("/api/clips?epochBelow=1", { token: owner.token })
    ).json()) as ListClipsResponse;
    expect(left.clips).toEqual([]);
  });

  it("refuses an empty or oversized batch", async () => {
    const { owner } = await withOldClip();
    const empty = await api("/api/clips/reencrypt", {
      method: "POST",
      token: owner.token,
      body: { items: [] },
    });
    expect(empty.status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `clip_${i}`, fromEpoch: 0, envelope: "v1.a.b", contentHash: "h",
    }));
    const tooMany = await api("/api/clips/reencrypt", {
      method: "POST",
      token: owner.token,
      body: { items: many },
    });
    expect(tooMany.status).toBe(400);
  });
});

describe("revocation and sealed keys", () => {
  it("deletes a revoked device's sealed copies", async () => {
    const { owner, phone } = await account();
    await rotate(owner.token, {
      sealedKeys: [{ deviceId: phone.deviceId, sealed: "d1.eph.iv.for-phone" }],
    });
    await api(`/api/devices/${phone.deviceId}`, { method: "DELETE", token: owner.token });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sealed_vault_keys WHERE device_id = ?",
    )
      .bind(phone.deviceId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
