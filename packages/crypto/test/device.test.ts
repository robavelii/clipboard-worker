import { describe, expect, it } from "vitest";
import {
  DeviceSealError,
  exportDeviceKeypair,
  generateDeviceKeypair,
  generateVaultKey,
  importDeviceKeypair,
  openVaultKeyForDevice,
  sealVaultKeyForDevice,
} from "../src/index";

const DEVICE = "dev_phone";

describe("sealing the vault key to a device", () => {
  it("round-trips to the device it was sealed for", async () => {
    const device = await generateDeviceKeypair(false);
    const vaultKey = generateVaultKey();
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: device.publicKey },
      3,
      vaultKey,
    );
    expect(await openVaultKeyForDevice(device, DEVICE, 3, sealed)).toBe(vaultKey);
  });

  it("never carries the vault key in the clear", async () => {
    const device = await generateDeviceKeypair(false);
    const vaultKey = generateVaultKey();
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: device.publicKey },
      1,
      vaultKey,
    );
    expect(sealed.startsWith("d1.")).toBe(true);
    expect(sealed).not.toContain(vaultKey);
  });

  it("does not open for any other device's key", async () => {
    const device = await generateDeviceKeypair(false);
    const other = await generateDeviceKeypair(false);
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: device.publicKey },
      1,
      generateVaultKey(),
    );
    await expect(
      openVaultKeyForDevice(other, DEVICE, 1, sealed),
    ).rejects.toBeInstanceOf(DeviceSealError);
  });

  // The server stores these per device and epoch. Binding both into the key
  // derivation means it cannot hand one device another's copy, or replay an
  // old epoch's copy as the current one.
  it("is bound to the device id", async () => {
    const device = await generateDeviceKeypair(false);
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: device.publicKey },
      1,
      generateVaultKey(),
    );
    await expect(
      openVaultKeyForDevice(device, "dev_laptop", 1, sealed),
    ).rejects.toBeInstanceOf(DeviceSealError);
  });

  it("is bound to the epoch", async () => {
    const device = await generateDeviceKeypair(false);
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: device.publicKey },
      1,
      generateVaultKey(),
    );
    await expect(
      openVaultKeyForDevice(device, DEVICE, 2, sealed),
    ).rejects.toBeInstanceOf(DeviceSealError);
  });

  it("survives export and import of an extractable keypair", async () => {
    const original = await generateDeviceKeypair(true);
    const stored = await exportDeviceKeypair(original);
    const restored = await importDeviceKeypair(stored);
    expect(restored.publicKey).toBe(original.publicKey);

    const vaultKey = generateVaultKey();
    const sealed = await sealVaultKeyForDevice(
      { deviceId: DEVICE, publicKey: original.publicKey },
      5,
      vaultKey,
    );
    expect(await openVaultKeyForDevice(restored, DEVICE, 5, sealed)).toBe(vaultKey);
  });

  it("refuses to export a non-extractable keypair", async () => {
    const device = await generateDeviceKeypair(false);
    await expect(exportDeviceKeypair(device)).rejects.toThrow();
  });

  it("rejects an envelope that is not a device seal", async () => {
    const device = await generateDeviceKeypair(false);
    await expect(
      openVaultKeyForDevice(device, DEVICE, 1, "l1.aaaa.bbbb"),
    ).rejects.toBeInstanceOf(DeviceSealError);
  });
});
