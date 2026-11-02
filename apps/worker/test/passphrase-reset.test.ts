/**
 * The operator's passphrase reset (decisions §50): the admin secret and one
 * of the account's devices together re-wrap the vault key that device holds
 * under a new passphrase. Real client flows and crypto, through SELF.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateVaultKey, toBase64Url } from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { signIn, signUp } from "@clipsync/client/account";
import { ringKeysFrom, ringOf, sealText } from "@clipsync/client/ring";
import { resetPassphraseAsAdmin } from "@clipsync/client/vault";
import type { MintSignupInviteResponse } from "@clipsync/protocol";
import { ADMIN_SECRET, api } from "./helpers";

const BASE = "https://clip.test";
const fetchImpl: typeof fetch = (input, init) => SELF.fetch(input as Request | string, init);
const passphrase = () => `reset test ${crypto.randomUUID()}`;
const randomB64 = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

async function newAccount() {
  const res = await api("/api/signup/invites", { method: "POST", body: { adminSecret: ADMIN_SECRET } });
  const { code } = (await res.json()) as MintSignupInviteResponse;
  const email = `forgot-${crypto.randomUUID().slice(0, 8)}@example.org`;
  const pass = passphrase();
  const enrolled = await signUp({ baseUrl: BASE, email, invite: code, passphrase: pass, deviceName: "laptop", platform: "linux", fetchImpl });
  const client = new ApiClient(BASE, enrolled.credentials.token, fetchImpl);
  // A clip under the current key, for the reset's check that the key is the account's.
  const keys = await ringKeysFrom(ringOf(enrolled.vaultKey, 0), enrolled.credentials.kdfSalt);
  await client.createClip(await sealText(keys, enrolled.credentials.userId, enrolled.credentials.deviceId, "kept across the reset"));
  return { email, pass, client, ...enrolled };
}

const signInWith = (email: string, pass: string) =>
  signIn({ baseUrl: BASE, email, passphrase: pass, deviceName: "phone", platform: "other", fetchImpl });

describe("the operator's passphrase reset", () => {
  it("re-wraps the same vault key under a new passphrase; the old one stops working", async () => {
    const { email, pass, client, credentials, vaultKey } = await newAccount();
    const fresh = passphrase();

    await resetPassphraseAsAdmin(client, {
      adminSecret: ADMIN_SECRET,
      account: credentials.userId,
      kdfSalt: credentials.kdfSalt,
      ring: ringOf(vaultKey, 0),
      newPassphrase: fresh,
    });

    const signedIn = await signInWith(email, fresh);
    expect(signedIn.vaultKey).toBe(vaultKey);
    await expect(signInWith(email, pass)).rejects.toBeInstanceOf(ApiRequestError);
    // The device that did it is untouched.
    expect((await client.listClips(5)).clips).toHaveLength(1);
  });

  it("refuses without the admin secret, and changes nothing", async () => {
    const { email, pass, client, credentials, vaultKey } = await newAccount();
    const attempt = resetPassphraseAsAdmin(client, {
      adminSecret: `not-${ADMIN_SECRET}`,
      account: credentials.userId,
      kdfSalt: credentials.kdfSalt,
      ring: ringOf(vaultKey, 0),
      newPassphrase: passphrase(),
    });
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect((await signInWith(email, pass)).vaultKey).toBe(vaultKey);
  });

  it("refuses without a device token: the admin secret alone is not enough", async () => {
    const res = await api("/api/account/passphrase-reset", {
      method: "POST",
      body: { adminSecret: ADMIN_SECRET, wrappedVaultKey: `k1.${randomB64()}`, authHash: randomB64(), keyEpoch: 0 },
    });
    expect(res.status).toBe(401);
  });

  it("will not wrap a key that doesn't open the account's clips", async () => {
    const { email, pass, client, credentials, vaultKey } = await newAccount();
    const attempt = resetPassphraseAsAdmin(client, {
      adminSecret: ADMIN_SECRET,
      account: credentials.userId,
      kdfSalt: credentials.kdfSalt,
      ring: ringOf(generateVaultKey(), 0),
      newPassphrase: passphrase(),
    });
    await expect(attempt).rejects.toThrow(/does not open/);
    expect((await signInWith(email, pass)).vaultKey).toBe(vaultKey);
  });

  it("is guarded on the epoch: a device behind a re-key writes nothing", async () => {
    const { credentials } = await newAccount();
    const res = await api("/api/account/passphrase-reset", {
      method: "POST",
      token: credentials.token,
      body: { adminSecret: ADMIN_SECRET, wrappedVaultKey: `k1.${randomB64()}`, authHash: randomB64(), keyEpoch: 7 },
    });
    expect(res.status).toBe(409);
  });
});
