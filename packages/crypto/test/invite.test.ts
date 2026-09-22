import { describe, expect, it } from "vitest";
import {
  generateInviteSecret,
  InviteError,
  inviteProof,
  openInvite,
  sealInvite,
} from "../src/invite";

const VAULT_KEY = "dGhpcy1pcy1hLTMyLWJ5dGUtdmF1bHQta2V5ISE";

describe("scan-to-join invites", () => {
  it("round-trips the vault key", async () => {
    const secret = generateInviteSecret();
    expect(await openInvite(secret, await sealInvite(secret, VAULT_KEY))).toBe(
      VAULT_KEY,
    );
  });

  it("never exposes the vault key in the sealed payload", async () => {
    const secret = generateInviteSecret();
    const sealed = await sealInvite(secret, VAULT_KEY);
    expect(sealed).not.toContain(VAULT_KEY);
    expect(sealed.startsWith("i1.")).toBe(true);
  });

  /**
   * The payload sits on the server. Anyone who reads the database but never
   * saw the QR must be unable to open it.
   */
  it("cannot be opened with a different secret", async () => {
    const sealed = await sealInvite(generateInviteSecret(), VAULT_KEY);
    await expect(
      openInvite(generateInviteSecret(), sealed),
    ).rejects.toBeInstanceOf(InviteError);
  });

  it("rejects a tampered payload", async () => {
    const secret = generateInviteSecret();
    const sealed = await sealInvite(secret, VAULT_KEY);
    await expect(
      openInvite(secret, `${sealed.slice(0, -4)}AAAA`),
    ).rejects.toBeInstanceOf(InviteError);
  });

  it("rejects a malformed payload", async () => {
    await expect(
      openInvite(generateInviteSecret(), "nope"),
    ).rejects.toBeInstanceOf(InviteError);
  });

  it("uses a fresh secret and nonce each time", async () => {
    const a = generateInviteSecret();
    const b = generateInviteSecret();
    expect(a).not.toBe(b);
    expect(await sealInvite(a, VAULT_KEY)).not.toBe(await sealInvite(a, VAULT_KEY));
  });
});

describe("invite proof", () => {
  /**
   * The proof goes to the server; the secret must not be recoverable from it,
   * or the server could open the payload it is holding.
   */
  it("is stable, distinct per secret, and reveals nothing", async () => {
    const secret = generateInviteSecret();
    const proof = await inviteProof(secret);

    expect(await inviteProof(secret)).toBe(proof);
    expect(proof).not.toBe(secret);
    expect(proof).not.toContain(secret);
    expect(await inviteProof(generateInviteSecret())).not.toBe(proof);
  });

  it("does not double as the sealing key", async () => {
    const secret = generateInviteSecret();
    const sealed = await sealInvite(secret, VAULT_KEY);
    // A server holding only the proof must not be able to open the payload.
    await expect(
      openInvite(await inviteProof(secret), sealed),
    ).rejects.toBeInstanceOf(InviteError);
  });
});
