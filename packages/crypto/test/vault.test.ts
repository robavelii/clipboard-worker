import { describe, expect, it } from "vitest";
import {
  DecryptError,
  decryptText,
  deriveKeys,
  encryptText,
  generateVaultKey,
  openVault,
  randomSalt,
  unwrapVaultKey,
  vaultKeysFrom,
  wrapVaultKey,
} from "../src/index";

const SALT = "Zm9vYmFyYmF6cXV4MTIzNA";
const PASSPHRASE = "correct horse battery staple";

const opened = await openVault(PASSPHRASE, SALT);

describe("vault key wrapping", () => {
  it("round-trips a vault key through the passphrase", async () => {
    const vaultKey = generateVaultKey();
    const wrapped = await wrapVaultKey(opened.kek, vaultKey);
    expect(await unwrapVaultKey(opened.kek, wrapped)).toBe(vaultKey);
  });

  it("never exposes the vault key in the wrapped blob", async () => {
    const vaultKey = generateVaultKey();
    const wrapped = await wrapVaultKey(opened.kek, vaultKey);
    expect(wrapped).not.toContain(vaultKey);
    expect(wrapped.startsWith("k1.")).toBe(true);
  });

  it("refuses to unwrap under the wrong passphrase", async () => {
    const wrapped = await wrapVaultKey(opened.kek, generateVaultKey());
    const wrong = await openVault("not the passphrase", SALT);
    await expect(unwrapVaultKey(wrong.kek, wrapped)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("refuses a tampered wrapped key", async () => {
    const wrapped = await wrapVaultKey(opened.kek, generateVaultKey());
    await expect(
      unwrapVaultKey(opened.kek, `${wrapped.slice(0, -4)}AAAA`),
    ).rejects.toBeInstanceOf(DecryptError);
  });
});

describe("migration from passphrase-derived keys", () => {
  /**
   * The property the whole migration rests on: treating the old PBKDF2 output
   * as the vault key reproduces the old content keys exactly, so clips written
   * before the vault key existed still decrypt afterwards.
   */
  it("reproduces the pre-vault-key content keys bit for bit", async () => {
    const legacyKeys = await deriveKeys(PASSPHRASE, SALT);
    const clip = await encryptText(legacyKeys, "docker compose up -d");

    const migrated = await vaultKeysFrom(opened.legacyVaultKey, SALT);
    expect(await decryptText(migrated, clip)).toBe("docker compose up -d");
  });

  it("keeps working after the passphrase changes", async () => {
    // Day one: an old account, clips encrypted under the legacy derivation.
    const vaultKey = opened.legacyVaultKey;
    const keys = await vaultKeysFrom(vaultKey, SALT);
    const clip = await encryptText(keys, "git reset --soft HEAD~1");

    // Rotation re-wraps 32 bytes. No clip is touched.
    const next = await openVault("an entirely different passphrase", SALT);
    const rewrapped = await wrapVaultKey(next.kek, vaultKey);

    const recovered = await unwrapVaultKey(next.kek, rewrapped);
    expect(await decryptText(await vaultKeysFrom(recovered, SALT), clip)).toBe(
      "git reset --soft HEAD~1",
    );

    // And the old passphrase no longer opens it.
    await expect(
      unwrapVaultKey(opened.kek, rewrapped),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("gives different accounts different content keys", async () => {
    const other = await openVault(PASSPHRASE, randomSalt());
    const a = await vaultKeysFrom(opened.legacyVaultKey, SALT);
    const b = await vaultKeysFrom(other.legacyVaultKey, SALT);
    const clip = await encryptText(a, "secret");
    await expect(decryptText(b, clip)).rejects.toBeInstanceOf(DecryptError);
  });
});
