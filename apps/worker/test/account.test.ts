/**
 * Deleting and exporting an account (decisions §46): what deleting removes
 * and what it leaves, the two confirmations it takes, and the admin
 * account bootstrap enrols into.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHashOf, openVault } from "@clipsync/crypto";
import type { AccountExport, Credentials, MintSignupInviteResponse } from "@clipsync/protocol";
import { outbox } from "../src/mail";
import { ADMIN_SECRET, api, bootstrap, v2Envelope } from "./helpers";

const PASSPHRASE = `delete test ${crypto.randomUUID()}`;

async function account(email: string): Promise<Credentials> {
  const { code: invite } = (await (
    await api("/api/signup/invites", { method: "POST", body: { adminSecret: ADMIN_SECRET } })
  ).json()) as MintSignupInviteResponse;
  const creds = (await (
    await api("/api/signup", { method: "POST", body: { email, invite, deviceName: "laptop", platform: "linux" } })
  ).json()) as Credentials;
  const { authProof } = await openVault(PASSPHRASE, creds.kdfSalt);
  const put = await api("/api/vault/key", {
    method: "PUT",
    token: creds.token,
    body: { wrappedVaultKey: "k1.wrapped", authHash: await authHashOf(authProof) },
  });
  expect(put.status).toBe(200);
  return creds;
}

async function textClip(who: Credentials): Promise<string> {
  const res = await api("/api/clips", {
    method: "POST",
    token: who.token,
    body: { type: "text", envelope: v2Envelope(who.deviceId), contentHash: `h-${Math.random()}`, size: 1, keyEpoch: 0 },
  });
  return ((await res.json()) as { id: string }).id;
}

async function imageClip(who: Credentials): Promise<string> {
  const { id: blobId } = (await (
    await api("/api/blobs", { method: "POST", token: who.token, body: { chunks: 1, bytes: 100 } })
  ).json()) as { id: string };
  await api(`/api/blobs/${blobId}/0`, { method: "PUT", token: who.token, raw: new Uint8Array(100) });
  await api("/api/clips", {
    method: "POST",
    token: who.token,
    body: { type: "image", envelope: v2Envelope(who.deviceId, "image"), contentHash: `i-${Math.random()}`, size: 1, keyEpoch: 0, blobId },
  });
  return blobId;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;
}

describe("exporting an account", () => {
  it("holds the account's clips and files, as ciphertext, and nobody else's", async () => {
    const owner = await bootstrap("owner");
    const ownerClip = await textClip(owner);
    const ada = await account(`ada-${crypto.randomUUID()}@example.org`);
    const clip = await textClip(ada);
    const blob = await imageClip(ada);

    const data = (await (await api("/api/account/export", { token: ada.token })).json()) as AccountExport;
    expect(data.account).toMatchObject({ id: ada.userId, wrappedVaultKey: "k1.wrapped", plan: "free" });
    expect(data.clips.map((c) => c.id)).toContain(clip);
    expect(data.clips.map((c) => c.id)).not.toContain(ownerClip);
    expect(data.blobs).toEqual([{ id: blob, chunks: 1, size: 100 }]);
    expect(data.devices.map((d) => d.id)).toEqual([ada.deviceId]);
  });
});

describe("deleting an account", () => {
  it("removes everything it held, and nothing of anyone else's", async () => {
    const owner = await bootstrap("owner");
    const ownerClip = await textClip(owner);
    const ada = await account(`bo-${crypto.randomUUID()}@example.org`);
    await textClip(ada);
    const blob = await imageClip(ada);
    // An approved link request still holding a sealed key for one of its devices.
    await env.DB.prepare(
      `INSERT INTO link_requests (id, public_key, device_name, platform, pickup_hash, created_at, expires_at, approved_at, device_id, wrapped_secret)
       VALUES ('lnk_test', 'pk', 'phone', 'android', 'h', 0, ?, 1, ?, 'sealed')`,
    )
      .bind(Date.now() + 60_000, ada.deviceId)
      .run();

    const { authProof } = await openVault(PASSPHRASE, ada.kdfSalt);
    expect((await api("/api/account", { method: "DELETE", token: ada.token, body: { authProof } })).status).toBe(200);

    expect((await api("/api/auth/me", { token: ada.token })).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?", ada.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?", ada.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM clips WHERE user_id = ?", ada.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM link_requests WHERE id = 'lnk_test'")).toBe(0);
    expect((await env.BLOBS.list({ prefix: `blobs/${blob}/` })).objects).toEqual([]);

    expect((await api(`/api/clips/${ownerClip}`, { token: owner.token })).status).toBe(200);
  });

  it("needs the passphrase's proof or the mailed code, not just a token", async () => {
    const email = `cy-${crypto.randomUUID()}@example.org`;
    const ada = await account(email);
    expect((await api("/api/account", { method: "DELETE", token: ada.token, body: {} })).status).toBe(400);
    const { authProof: wrong } = await openVault("not the passphrase", ada.kdfSalt);
    expect((await api("/api/account", { method: "DELETE", token: ada.token, body: { authProof: wrong } })).status).toBe(403);
    expect((await api("/api/account", { method: "DELETE", token: ada.token, body: { emailCode: "123456" } })).status).toBe(403);

    expect((await api("/api/account/deletion-code", { method: "POST", token: ada.token })).status).toBe(202);
    const mail = outbox.filter((m) => m.to === email).at(-1)!;
    const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
    expect((await api("/api/account", { method: "DELETE", token: ada.token, body: { emailCode: code } })).status).toBe(200);
    expect((await api("/api/auth/me", { token: ada.token })).status).toBe(401);
  });

  it("refuses a mailed code for an account with no address", async () => {
    const owner = await bootstrap("owner");
    expect((await api("/api/account/deletion-code", { method: "POST", token: owner.token })).status).toBe(400);
  });
});

describe("the admin account", () => {
  it("is the one bootstrap enrols into, and once deleted, bootstrap makes a new one", async () => {
    const owner = await bootstrap("owner");
    await account(`dee-${crypto.randomUUID()}@example.org`);
    expect((await bootstrap("owner-again")).userId).toBe(owner.userId);

    // The owner's account goes; the admin secret must not land in Dee's.
    const ownerVault = await openVault(PASSPHRASE, owner.kdfSalt);
    await api("/api/vault/key", {
      method: "PUT",
      token: owner.token,
      body: { wrappedVaultKey: "k1.owner", authHash: await authHashOf(ownerVault.authProof) },
    });
    expect((await api("/api/account", { method: "DELETE", token: owner.token, body: { authProof: ownerVault.authProof } })).status).toBe(200);

    const fresh = await bootstrap("owner-after");
    expect(fresh.createdAccount).toBe(true);
    expect(fresh.userId).not.toBe(owner.userId);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE admin = 1")).toBe(1);
  });
});

describe("the account's address", () => {
  const codeFor = (email: string) => /\b(\d{6})\b/.exec(outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;

  it("is set with a code mailed to it and the passphrase, never one alone", async () => {
    const owner = await bootstrap("owner");
    const { authProof } = await openVault(PASSPHRASE, owner.kdfSalt);
    await api("/api/vault/key", {
      method: "PUT",
      token: owner.token,
      body: { wrappedVaultKey: "k1.owner", authHash: await authHashOf(authProof) },
    });
    const email = `own-${crypto.randomUUID()}@example.org`;
    expect((await api("/api/account/email/code", { method: "POST", token: owner.token, body: { email } })).status).toBe(202);
    const code = codeFor(email);

    const { authProof: wrong } = await openVault("not the passphrase", owner.kdfSalt);
    expect((await api("/api/account/email", { method: "PUT", token: owner.token, body: { email, code, authProof: wrong } })).status).toBe(403);
    expect(
      (await api("/api/account/email", { method: "PUT", token: owner.token, body: { email, code: "000000", authProof } })).status,
    ).toBe(403);
    expect((await api("/api/account/email", { method: "PUT", token: owner.token, body: { email, code, authProof } })).status).toBe(200);

    const me = (await (await api("/api/auth/me", { token: owner.token })).json()) as { email: string };
    expect(me.email).toBe(email);
    // The address now signs a device in.
    const signin = await api("/api/signin", { method: "POST", body: { email, authProof, deviceName: "new", platform: "linux" } });
    expect(signin.status).toBe(200);
  });

  it("tells the old address when it changes, and refuses one another account has", async () => {
    const first = `old-${crypto.randomUUID()}@example.org`;
    const ada = await account(first);
    const other = await account(`taken-${crypto.randomUUID()}@example.org`);
    const { authProof } = await openVault(PASSPHRASE, ada.kdfSalt);

    const taken = await api("/api/auth/me", { token: other.token }).then((r) => r.json() as Promise<{ email: string }>);
    expect((await api("/api/account/email/code", { method: "POST", token: ada.token, body: { email: taken.email } })).status).toBe(409);

    const next = `new-${crypto.randomUUID()}@example.org`;
    await api("/api/account/email/code", { method: "POST", token: ada.token, body: { email: next } });
    expect(
      (await api("/api/account/email", { method: "PUT", token: ada.token, body: { email: next, code: codeFor(next), authProof } })).status,
    ).toBe(200);
    expect(outbox.filter((m) => m.to === first).at(-1)!.subject).toMatch(/address changed/);
  });
});

