import { describe, expect, it } from "vitest";
import {
  createLinkKeypair,
  fingerprint,
  LinkError,
  openFromDevice,
  sealToDevice,
} from "../src/link";

const SECRET = "correct horse battery staple";

describe("device linking", () => {
  it("transfers a secret end to end", async () => {
    const joiner = await createLinkKeypair();
    const { envelope, approverPublicKey } = await sealToDevice(
      joiner.publicKey,
      SECRET,
    );
    expect(await openFromDevice(joiner, approverPublicKey, envelope)).toBe(
      SECRET,
    );
  });

  it("never puts the secret on the wire", async () => {
    const joiner = await createLinkKeypair();
    const { envelope } = await sealToDevice(joiner.publicKey, SECRET);
    expect(envelope).not.toContain(SECRET);
    expect(envelope.startsWith("l1.")).toBe(true);
  });

  it("uses a fresh ephemeral key per approval", async () => {
    const joiner = await createLinkKeypair();
    const a = await sealToDevice(joiner.publicKey, SECRET);
    const b = await sealToDevice(joiner.publicKey, SECRET);
    expect(a.approverPublicKey).not.toBe(b.approverPublicKey);
    expect(a.envelope).not.toBe(b.envelope);
  });

  /**
   * The attack the design exists to stop: a malicious server hands the
   * approver its own public key instead of the joining device's, so it can
   * read the secret and re-seal it. The joining device must fail closed.
   */
  it("fails when the server substitutes the joiner's public key", async () => {
    const joiner = await createLinkKeypair();
    const attacker = await createLinkKeypair();

    const intercepted = await sealToDevice(attacker.publicKey, SECRET);

    await expect(
      openFromDevice(joiner, intercepted.approverPublicKey, intercepted.envelope),
    ).rejects.toBeInstanceOf(LinkError);
  });

  it("fails when the approver's public key is swapped in transit", async () => {
    const joiner = await createLinkKeypair();
    const impostor = await createLinkKeypair();
    const { envelope } = await sealToDevice(joiner.publicKey, SECRET);

    await expect(
      openFromDevice(joiner, impostor.publicKey, envelope),
    ).rejects.toBeInstanceOf(LinkError);
  });

  it("rejects a tampered envelope", async () => {
    const joiner = await createLinkKeypair();
    const { envelope, approverPublicKey } = await sealToDevice(
      joiner.publicKey,
      SECRET,
    );
    const broken = `${envelope.slice(0, -4)}AAAA`;
    await expect(
      openFromDevice(joiner, approverPublicKey, broken),
    ).rejects.toBeInstanceOf(LinkError);
  });

  it("rejects a malformed envelope", async () => {
    const joiner = await createLinkKeypair();
    const { approverPublicKey } = await sealToDevice(joiner.publicKey, SECRET);
    await expect(
      openFromDevice(joiner, approverPublicKey, "nonsense"),
    ).rejects.toBeInstanceOf(LinkError);
  });
});

describe("fingerprints", () => {
  it("is stable and formatted for reading aloud", async () => {
    const { publicKey } = await createLinkKeypair();
    const fp = await fingerprint(publicKey);
    expect(fp).toMatch(/^\d{3}-\d{3}$/);
    expect(await fingerprint(publicKey)).toBe(fp);
  });

  it("differs between keys", async () => {
    const a = await createLinkKeypair();
    const b = await createLinkKeypair();
    expect(await fingerprint(a.publicKey)).not.toBe(
      await fingerprint(b.publicKey),
    );
  });
});
