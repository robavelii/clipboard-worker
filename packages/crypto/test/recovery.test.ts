import { describe, expect, it } from "vitest";
import {
  createRecovery,
  DeviceSealError,
  generateRecoveryKey,
  generateVaultKey,
  openRecovery,
  parseRecoveryKey,
  RecoveryKeyError,
  recoveryProofOf,
  sealForRecovery,
} from "../src/index";

const ACCOUNT = "usr_owner";

describe("the recovery key", () => {
  it("is CSR1 and 14 groups of four", async () => {
    const key = await generateRecoveryKey();
    expect(key).toMatch(/^CSR1(-[0-9A-HJKMNP-TV-Z]{4}){14}$/);
    expect(await generateRecoveryKey()).not.toBe(key);
  });

  it("reads back however it is typed", async () => {
    const key = await generateRecoveryKey();
    const secret = await parseRecoveryKey(key);
    expect(secret).toHaveLength(32);
    const sloppy = key.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect([...(await parseRecoveryKey(sloppy))]).toEqual([...secret]);
    expect([...(await parseRecoveryKey(key.replace(/^CSR1-/, "")))]).toEqual([...secret]);
  });

  it("catches a typo before it is tried", async () => {
    const key = await generateRecoveryKey();
    const last = key.at(-1)!;
    const typo = key.slice(0, -1) + (last === "Z" ? "Y" : "Z");
    await expect(parseRecoveryKey(typo)).rejects.toThrow(/typo/);
    await expect(parseRecoveryKey("CSR1-ABCD")).rejects.toBeInstanceOf(RecoveryKeyError);
  });
});

describe("recovering the vault key", () => {
  it("opens the vault key it was made with", async () => {
    const key = await generateRecoveryKey();
    const vaultKey = generateVaultKey();
    const material = await createRecovery(key, ACCOUNT, vaultKey, 2);
    expect(material.epoch).toBe(2);
    expect(await openRecovery(key, ACCOUNT, material)).toBe(vaultKey);
  });

  it("gives the server nothing that opens anything", async () => {
    const key = await generateRecoveryKey();
    const vaultKey = generateVaultKey();
    const material = await createRecovery(key, ACCOUNT, vaultKey, 0);
    const stored = JSON.stringify(material);
    expect(stored).not.toContain(vaultKey);
    expect(stored).not.toContain(await recoveryProofOf(key));
    expect(material.wrappedPrivateKey).toMatch(/^r1\./);
    expect(material.sealed).toMatch(/^d1\./);
  });

  it("follows a re-key: a new vault key sealed to the same public key", async () => {
    const key = await generateRecoveryKey();
    const material = await createRecovery(key, ACCOUNT, generateVaultKey(), 0);
    const next = generateVaultKey();
    const sealed = await sealForRecovery(material.publicKey, ACCOUNT, 1, next);
    expect(await openRecovery(key, ACCOUNT, { ...material, sealed, epoch: 1 })).toBe(next);
  });

  it("refuses another recovery key", async () => {
    const material = await createRecovery(await generateRecoveryKey(), ACCOUNT, generateVaultKey(), 0);
    await expect(openRecovery(await generateRecoveryKey(), ACCOUNT, material)).rejects.toThrow(/does not open/);
  });

  it("is bound to its account", async () => {
    const key = await generateRecoveryKey();
    const material = await createRecovery(key, ACCOUNT, generateVaultKey(), 0);
    await expect(openRecovery(key, "usr_someone_else", material)).rejects.toThrow(/does not open/);
  });

  it("is bound to its epoch: an old seal cannot pass for the current one", async () => {
    const key = await generateRecoveryKey();
    const material = await createRecovery(key, ACCOUNT, generateVaultKey(), 3);
    await expect(openRecovery(key, ACCOUNT, { ...material, epoch: 4 })).rejects.toBeInstanceOf(DeviceSealError);
  });

  it("derives the same proof every time, and a different one per key", async () => {
    const key = await generateRecoveryKey();
    expect(await recoveryProofOf(key)).toBe(await recoveryProofOf(key.toLowerCase()));
    expect(await recoveryProofOf(key)).not.toBe(await recoveryProofOf(await generateRecoveryKey()));
  });
});
