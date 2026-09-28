import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHashOf } from "@clipsync/crypto";
import type { VaultKeyResponse } from "@clipsync/protocol";
import { api, bootstrap } from "./helpers";

const WRAPPED = "k1.aXYtaXYtaXYtaXY.Y2lwaGVydGV4dA";
const REWRAPPED = "k1.b3RoZXItaXYtaXY.bmV3LWNpcGhlcnRleHQ";

/** Stand-ins for openVault().authProof under two different passphrases. */
const OWNER_PROOF = "b3duZXItcHJvb2Ytb3duZXItcHJvb2Ytb3duZXItcHI";
const OTHER_PROOF = "b3RoZXItcHJvb2Ytb3RoZXItcHJvb2Ytb3RoZXItcHI";

async function putKey(token: string, body: Record<string, unknown>) {
  return api("/api/vault/key", { method: "PUT", token, body });
}

async function storedKey(token: string): Promise<string | null> {
  const res = await api("/api/vault/key", { token });
  return ((await res.json()) as VaultKeyResponse).wrappedVaultKey;
}

/** An account whose vault key is wrapped under OWNER_PROOF's passphrase. */
async function ownedAccount() {
  const device = await bootstrap();
  const res = await putKey(device.token, {
    wrappedVaultKey: WRAPPED,
    authHash: await authHashOf(OWNER_PROOF),
  });
  expect(res.status).toBe(200);
  return device;
}

describe("GET /api/vault/key", () => {
  it("requires a device token", async () => {
    expect((await api("/api/vault/key")).status).toBe(401);
  });

  it("starts empty on a new account, with the account's salt", async () => {
    const device = await bootstrap();
    const res = await api("/api/vault/key", { token: device.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VaultKeyResponse;
    expect(body.kdfSalt).toBe(device.kdfSalt);
    expect(body.wrappedVaultKey).toBeNull();
  });
});

describe("PUT /api/vault/key", () => {
  it("stores the first wrapped key without a proof, and hands it back", async () => {
    const device = await ownedAccount();
    expect(await storedKey(device.token)).toBe(WRAPPED);
  });

  const HASH = "x".repeat(43);
  it.each([
    ["no key", { authHash: HASH }],
    ["a key that is not a k1 envelope", { wrappedVaultKey: "v1.not.a.key", authHash: HASH }],
    ["an oversized key", { wrappedVaultKey: `k1.${"a".repeat(600)}`, authHash: HASH }],
    ["no proof hash", { wrappedVaultKey: WRAPPED }],
    ["a malformed proof hash", { wrappedVaultKey: WRAPPED, authHash: "short" }],
  ])("refuses a body with %s", async (_label, body) => {
    const device = await bootstrap();
    expect((await putKey(device.token, body)).status).toBe(400);
  });

  it("requires a device token", async () => {
    const res = await api("/api/vault/key", {
      method: "PUT",
      body: { wrappedVaultKey: WRAPPED, authHash: "x".repeat(43) },
    });
    expect(res.status).toBe(401);
  });

  // Audit O1: a device holding the vault key but not the passphrase could
  // wrap the key under a passphrase of its own and lock the owner out.
  describe("replacing an existing key", () => {
    it("is refused without proof of the current passphrase", async () => {
      const device = await ownedAccount();
      const res = await putKey(device.token, {
        wrappedVaultKey: REWRAPPED,
        authHash: await authHashOf(OTHER_PROOF),
      });
      expect(res.status).toBe(403);
      expect(await storedKey(device.token)).toBe(WRAPPED);
    });

    it("is refused with proof of a different passphrase", async () => {
      const device = await ownedAccount();
      const res = await putKey(device.token, {
        wrappedVaultKey: REWRAPPED,
        authHash: await authHashOf(OTHER_PROOF),
        authProof: OTHER_PROOF,
      });
      expect(res.status).toBe(403);
      expect(await storedKey(device.token)).toBe(WRAPPED);
    });

    it("is refused to the stored hash itself: the hash is not the proof", async () => {
      const device = await ownedAccount();
      const res = await putKey(device.token, {
        wrappedVaultKey: REWRAPPED,
        authHash: await authHashOf(OTHER_PROOF),
        authProof: await authHashOf(OWNER_PROOF),
      });
      expect(res.status).toBe(403);
    });

    it("rotates with the current proof, after which the old proof is dead", async () => {
      const device = await ownedAccount();
      const rotate = await putKey(device.token, {
        wrappedVaultKey: REWRAPPED,
        authHash: await authHashOf(OTHER_PROOF),
        authProof: OWNER_PROOF,
      });
      expect(rotate.status).toBe(200);
      expect(await storedKey(device.token)).toBe(REWRAPPED);

      const replay = await putKey(device.token, {
        wrappedVaultKey: WRAPPED,
        authHash: await authHashOf(OWNER_PROOF),
        authProof: OWNER_PROOF,
      });
      expect(replay.status).toBe(403);
    });
  });
});

describe("POST /api/vault/auth", () => {
  /** An account from before passphrase proofs: a wrapped key, no hash. */
  async function legacyAccount() {
    const device = await bootstrap();
    await env.DB.prepare(
      "UPDATE users SET wrapped_vault_key = ?, auth_hash = NULL WHERE id = ?",
    )
      .bind(WRAPPED, device.userId)
      .run();
    return device;
  }

  async function claim(token: string, proof: string) {
    return api("/api/vault/auth", {
      method: "POST",
      token,
      body: { authHash: await authHashOf(proof) },
    });
  }

  it("registers the first proof hash on an account that has none", async () => {
    const device = await legacyAccount();
    const res = await claim(device.token, OWNER_PROOF);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: true });

    // From then on the key can only be replaced with that proof.
    const rotate = await putKey(device.token, {
      wrappedVaultKey: REWRAPPED,
      authHash: await authHashOf(OTHER_PROOF),
      authProof: OWNER_PROOF,
    });
    expect(rotate.status).toBe(200);
  });

  it("is idempotent for the same proof", async () => {
    const device = await legacyAccount();
    await claim(device.token, OWNER_PROOF);
    const again = await claim(device.token, OWNER_PROOF);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ claimed: false });
  });

  it("refuses a different proof once one is registered", async () => {
    const device = await legacyAccount();
    await claim(device.token, OWNER_PROOF);
    expect((await claim(device.token, OTHER_PROOF)).status).toBe(409);
  });

  it("does not let a legacy account's key be replaced before a claim", async () => {
    const device = await legacyAccount();
    const res = await putKey(device.token, {
      wrappedVaultKey: REWRAPPED,
      authHash: await authHashOf(OTHER_PROOF),
      authProof: OTHER_PROOF,
    });
    expect(res.status).toBe(403);
  });
});
