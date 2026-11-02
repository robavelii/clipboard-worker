/**
 * The recovery key (decisions §48), end to end against the Worker: the real
 * client flows (sign-up, recovery, re-key) with the real crypto, talking to
 * the Worker through SELF.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHashOf, generateRecoveryKey, openVault, recoveryProofOf, unwrapVaultKey } from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { signIn, signUp } from "@clipsync/client/account";
import { recoverAccount, setUpRecovery } from "@clipsync/client/recovery";
import { rekeyVault } from "@clipsync/client/rekey";
import { ringOf } from "@clipsync/client/ring";
import type { MintSignupInviteResponse } from "@clipsync/protocol";
import { outbox } from "../src/mail";
import { ADMIN_SECRET, api } from "./helpers";

const BASE = "https://clip.test";
const fetchImpl: typeof fetch = (input, init) => SELF.fetch(input as Request | string, init);
const passphrase = () => `recovery test ${crypto.randomUUID()}`;

async function invite(): Promise<string> {
  const res = await api("/api/signup/invites", { method: "POST", body: { adminSecret: ADMIN_SECRET } });
  return ((await res.json()) as MintSignupInviteResponse).code;
}

async function newAccount() {
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.org`;
  const pass = passphrase();
  const enrolled = await signUp({
    baseUrl: BASE,
    email,
    invite: await invite(),
    passphrase: pass,
    deviceName: "laptop",
    platform: "linux",
    fetchImpl,
  });
  const client = new ApiClient(BASE, enrolled.credentials.token, fetchImpl);
  return { email, pass, ...enrolled, client };
}

const status = async (token: string) =>
  (await api("/api/account/recovery", { token })).json() as Promise<{ publicKey: string | null; epoch: number | null; keyEpoch: number }>;

describe("the recovery key", () => {
  it("is made at sign-up, and the server holds only what opens nothing", async () => {
    const { credentials, recoveryKey, vaultKey } = await newAccount();
    expect(recoveryKey).toMatch(/^CSR1-/);
    expect(await status(credentials.token)).toMatchObject({ epoch: 0, keyEpoch: 0 });

    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(credentials.userId).first<Record<string, unknown>>();
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(recoveryKey!);
    expect(stored).not.toContain(await recoveryProofOf(recoveryKey!));
    expect(stored).not.toContain(vaultKey);
    expect(row!.recovery_private).toMatch(/^r1\./);
  });

  it("resets a forgotten passphrase, keeping the vault key and the other devices", async () => {
    const { email, pass, credentials, recoveryKey, vaultKey } = await newAccount();
    const fresh = passphrase();

    const recovered = await recoverAccount({
      baseUrl: BASE,
      email,
      recoveryKey: recoveryKey!,
      newPassphrase: fresh,
      deviceName: "new laptop",
      platform: "linux",
      fetchImpl,
    });
    expect(recovered.vaultKey).toBe(vaultKey);
    expect(recovered.credentials.userId).toBe(credentials.userId);

    // The new passphrase opens the account; the old one no longer does.
    const signedIn = await signIn({ baseUrl: BASE, email, passphrase: fresh, deviceName: "phone", platform: "other", fetchImpl });
    expect(signedIn.vaultKey).toBe(vaultKey);
    await expect(
      signIn({ baseUrl: BASE, email, passphrase: pass, deviceName: "x", platform: "other", fetchImpl }),
    ).rejects.toMatchObject({ status: 403 });

    // The device enrolled before it is untouched.
    expect((await api("/api/auth/me", { token: credentials.token })).status).toBe(200);

    // And the owner is told.
    expect(outbox.filter((m) => m.to === email).at(-1)!.subject).toMatch(/reset with your recovery key/);
  });

  it("can sign every other device out while it is at it", async () => {
    const { email, credentials, recoveryKey } = await newAccount();
    const recovered = await recoverAccount({
      baseUrl: BASE,
      email,
      recoveryKey: recoveryKey!,
      newPassphrase: passphrase(),
      deviceName: "replacement",
      platform: "linux",
      revokeOtherDevices: true,
      fetchImpl,
    });
    expect((await api("/api/auth/me", { token: credentials.token })).status).toBe(401);
    expect((await api("/api/auth/me", { token: recovered.credentials.token })).status).toBe(200);
  });

  it("refuses another recovery key, and an unknown address, alike", async () => {
    const { email, recoveryKey } = await newAccount();
    const wrong = await api("/api/recovery/open", {
      method: "POST",
      body: { email, recoveryProof: await recoveryProofOf(await generateRecoveryKey()) },
    });
    const nobody = await api("/api/recovery/open", {
      method: "POST",
      body: { email: "nobody@example.org", recoveryProof: await recoveryProofOf(recoveryKey!) },
    });
    expect(wrong.status).toBe(403);
    expect(nobody.status).toBe(403);
    expect(await wrong.json()).toEqual(await nobody.json());
  });

  it("needs the passphrase to be replaced: a device token is not enough", async () => {
    const { credentials, client, vaultKey } = await newAccount();
    const before = await status(credentials.token);
    await expect(
      setUpRecovery(client, { account: credentials.userId, passphrase: "not the passphrase", kdfSalt: credentials.kdfSalt, vaultKey }),
    ).rejects.toThrow();
    const forged = await api("/api/account/recovery", {
      method: "PUT",
      token: credentials.token,
      body: {
        authProof: "bm90LXRoZS1wcm9vZi1ub3QtdGhlLXByb29mLW5vdC10aGU",
        publicKey: `B${"Q".repeat(86)}`,
        wrappedPrivateKey: "r1.aXY.Y3Q",
        sealed: "d1.cHVi.aXY.Y3Q",
        epoch: 0,
        recoveryHash: "aGFzaC1oYXNoLWhhc2gtaGFzaC1oYXNoLWhhc2gtaGF",
      },
    });
    expect(forged.status).toBe(403);
    expect(await status(credentials.token)).toEqual(before);
  });

  it("follows a re-key, which must seal the new vault key to it", async () => {
    const { email, pass, credentials, client, recoveryKey, vaultKey } = await newAccount();

    // A client that predates recovery keys cannot leave it behind.
    const { wrappedVaultKey } = await client.vaultKey();
    const opened = await openVault(pass, credentials.kdfSalt);
    expect(await unwrapVaultKey(opened.kek, wrappedVaultKey!)).toBe(vaultKey);
    const old = await client
      .rotateVault({
        fromEpoch: 0,
        authProof: opened.authProof,
        authHash: await authHashOf(opened.authProof),
        wrappedVaultKey: wrappedVaultKey!,
        sealedKeys: [],
      })
      .catch((err: unknown) => err);
    expect(old).toBeInstanceOf(ApiRequestError);
    expect(old).toMatchObject({ status: 400, message: expect.stringMatching(/recovery key/) });
    expect((await status(credentials.token)).keyEpoch).toBe(0);

    const rekeyed = await rekeyVault(client, { account: credentials.userId, kdfSalt: credentials.kdfSalt, ring: ringOf(vaultKey) }, pass);
    expect(rekeyed.epoch).toBe(1);
    expect(await status(credentials.token)).toMatchObject({ epoch: 1, keyEpoch: 1 });

    const recovered = await recoverAccount({
      baseUrl: BASE,
      email,
      recoveryKey: recoveryKey!,
      newPassphrase: passphrase(),
      deviceName: "after re-key",
      platform: "linux",
      fetchImpl,
    });
    expect(recovered.vaultKey).toBe(rekeyed.ring.keys["1"]);
    expect(recovered.vaultKey).not.toBe(vaultKey);
  });

  it("says so when a re-key left it behind, rather than opening an old key", async () => {
    const { email, credentials, recoveryKey } = await newAccount();
    await env.DB.prepare("UPDATE users SET key_epoch = key_epoch + 1 WHERE id = ?").bind(credentials.userId).run();
    const res = await api("/api/recovery/open", {
      method: "POST",
      body: { email, recoveryProof: await recoveryProofOf(recoveryKey!) },
    });
    expect(res.status).toBe(409);
  });

  it("can be replaced, and the old one stops working", async () => {
    const { email, pass, credentials, client, recoveryKey, vaultKey } = await newAccount();
    const replacement = await setUpRecovery(client, { account: credentials.userId, passphrase: pass, kdfSalt: credentials.kdfSalt, vaultKey });
    expect(replacement).not.toBe(recoveryKey);
    await expect(
      recoverAccount({ baseUrl: BASE, email, recoveryKey: recoveryKey!, newPassphrase: passphrase(), deviceName: "x", platform: "linux", fetchImpl }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    const recovered = await recoverAccount({
      baseUrl: BASE,
      email,
      recoveryKey: replacement,
      newPassphrase: passphrase(),
      deviceName: "y",
      platform: "linux",
      fetchImpl,
    });
    expect(recovered.vaultKey).toBe(vaultKey);
  });

  it("goes with the account", async () => {
    const { pass, credentials } = await newAccount();
    const { authProof } = await openVault(pass, credentials.kdfSalt);
    expect((await api("/api/account", { method: "DELETE", token: credentials.token, body: { authProof } })).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").bind(credentials.userId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
