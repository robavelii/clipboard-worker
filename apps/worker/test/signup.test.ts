/**
 * Accounts beyond the first (decisions §45): signup by a mailed code or an
 * admin's invite, and sign-in with the passphrase's proof. Mail goes to the
 * in-memory outbox (MAIL_MODE=outbox in vitest.config.ts).
 */

import { describe, expect, it } from "vitest";
import { authHashOf, openVault } from "@clipsync/crypto";
import type { BlobUsageResponse, Credentials, MintSignupInviteResponse, SigninSaltResponse } from "@clipsync/protocol";
import { outbox } from "../src/mail";
import { ADMIN_SECRET, api, bootstrap } from "./helpers";

const device = { deviceName: "phone", platform: "android" };

function lastCodeFor(email: string): string {
  const mail = outbox.filter((m) => m.to === email).at(-1);
  expect(mail).toBeDefined();
  return /\b(\d{6})\b/.exec(mail!.text)![1]!;
}

async function mintInvite(): Promise<string> {
  const res = await api("/api/signup/invites", { method: "POST", body: { adminSecret: ADMIN_SECRET } });
  expect(res.status).toBe(200);
  return ((await res.json()) as MintSignupInviteResponse).code;
}

/** An account made by invite, with its vault set under `passphrase`. */
async function accountWithVault(email: string, passphrase: string): Promise<Credentials> {
  const res = await api("/api/signup", { method: "POST", body: { email, invite: await mintInvite(), ...device } });
  expect(res.status).toBe(200);
  const creds = (await res.json()) as Credentials;
  const { authProof } = await openVault(passphrase, creds.kdfSalt);
  const put = await api("/api/vault/key", {
    method: "PUT",
    token: creds.token,
    body: { wrappedVaultKey: "k1.test-wrapped-key", authHash: await authHashOf(authProof) },
  });
  expect(put.status).toBe(200);
  return creds;
}

describe("signup by mailed code", () => {
  it("mails a code, and the code makes an account on the free plan", async () => {
    const email = `ada-${crypto.randomUUID()}@example.org`;
    expect((await api("/api/signup/email", { method: "POST", body: { email: ` ${email.toUpperCase()} ` } })).status).toBe(202);
    const code = lastCodeFor(email);

    const res = await api("/api/signup", { method: "POST", body: { email, code, ...device } });
    expect(res.status).toBe(200);
    const creds = (await res.json()) as Credentials;
    expect(creds).toMatchObject({ createdAccount: true, wrappedVaultKey: null, keyEpoch: 0 });
    const usage = (await (await api("/api/blobs/usage", { token: creds.token })).json()) as BlobUsageResponse;
    expect(usage.account?.plan).toBe("free");

    // The code works once, and the address now has an account.
    expect((await api("/api/signup", { method: "POST", body: { email, code, ...device } })).status).toBe(409);
  });

  it("sends at most one mail a minute to an address", async () => {
    const email = `bo-${crypto.randomUUID()}@example.org`;
    await api("/api/signup/email", { method: "POST", body: { email } });
    await api("/api/signup/email", { method: "POST", body: { email } });
    expect(outbox.filter((m) => m.to === email)).toHaveLength(1);
  });

  it("ends a code after five wrong guesses", async () => {
    const email = `cy-${crypto.randomUUID()}@example.org`;
    await api("/api/signup/email", { method: "POST", body: { email } });
    const code = lastCodeFor(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await api("/api/signup", { method: "POST", body: { email, code: wrong, ...device } })).status).toBe(400);
    }
    expect((await api("/api/signup", { method: "POST", body: { email, code, ...device } })).status).toBe(400);
  });

  it("refuses an address that is not one", async () => {
    for (const email of ["", "no-at-sign", "a@b", "a b@example.org", "x@example.org\r\nBcc: y@example.org"]) {
      expect((await api("/api/signup/email", { method: "POST", body: { email } })).status).toBe(400);
    }
  });
});

describe("signup by admin invite", () => {
  it("needs the admin secret to mint, and an invite works once", async () => {
    expect((await api("/api/signup/invites", { method: "POST", body: { adminSecret: "wrong" } })).status).toBe(403);
    const invite = await mintInvite();
    const first = await api("/api/signup", { method: "POST", body: { email: `di-${crypto.randomUUID()}@example.org`, invite, ...device } });
    expect(first.status).toBe(200);
    const again = await api("/api/signup", { method: "POST", body: { email: `ed-${crypto.randomUUID()}@example.org`, invite, ...device } });
    expect(again.status).toBe(400);
  });

  it("leaves bootstrap's first account where it was", async () => {
    const owner = await bootstrap("owner");
    const other = await accountWithVault(`fy-${crypto.randomUUID()}@example.org`, "correct horse");
    expect(other.userId).not.toBe(owner.userId);
    const again = await bootstrap("owner-again");
    expect(again.userId).toBe(owner.userId);
  });
});

describe("sign-in with the passphrase", () => {
  it("enrols a device into the account, given the right proof", async () => {
    const email = `gu-${crypto.randomUUID()}@example.org`;
    const made = await accountWithVault(email, "correct horse battery");

    const { kdfSalt } = (await (await api("/api/signin/salt", { method: "POST", body: { email } })).json()) as SigninSaltResponse;
    expect(kdfSalt).toBe(made.kdfSalt);
    const { authProof } = await openVault("correct horse battery", kdfSalt);
    const res = await api("/api/signin", { method: "POST", body: { email, authProof, deviceName: "laptop", platform: "linux" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: made.userId, wrappedVaultKey: "k1.test-wrapped-key" });

    const { authProof: wrong } = await openVault("wrong passphrase", kdfSalt);
    expect((await api("/api/signin", { method: "POST", body: { email, authProof: wrong, ...device } })).status).toBe(403);
  });

  it("gives an unknown address a salt as stable as a real one", async () => {
    const salt = async (email: string) =>
      ((await (await api("/api/signin/salt", { method: "POST", body: { email } })).json()) as SigninSaltResponse).kdfSalt;
    const nobody = `nobody-${crypto.randomUUID()}@example.org`;
    expect(await salt(nobody)).toBe(await salt(nobody));
    expect(await salt(nobody)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await api("/api/signin", { method: "POST", body: { email: nobody, authProof: "x", ...device } })).status).toBe(403);
  });

  it("locks an account's sign-in for the hour after ten failures", async () => {
    const email = `ha-${crypto.randomUUID()}@example.org`;
    const made = await accountWithVault(email, "right one");
    for (let i = 0; i < 10; i++) {
      expect((await api("/api/signin", { method: "POST", body: { email, authProof: `guess-${i}`, ...device } })).status).toBe(403);
    }
    const { authProof } = await openVault("right one", made.kdfSalt);
    expect((await api("/api/signin", { method: "POST", body: { email, authProof, ...device } })).status).toBe(429);
  });
});
