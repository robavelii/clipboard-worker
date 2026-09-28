/**
 * Long-term device keys, and sealing the vault key to them.
 *
 * Re-keying the vault means handing a fresh vault key to every device that
 * should keep reading the clipboard. Devices joined by link or invite never
 * learn the passphrase, so the passphrase-wrapped copy is no use to them;
 * each device instead holds a P-256 keypair from enrolment, and the device
 * running the re-key seals the new key to each one's public key. A revoked
 * device gets no copy.
 *
 *   sealed = "d1." + ephemeralPub + "." + iv + "." + AES-GCM(K, vaultKey)
 *   K = HKDF(ECDH(ephemeral, devicePub),
 *            "clipsync:device-seal:v1:<deviceId>:<epoch>:<devicePub>:<ephemeralPub>")
 *
 * The device id and epoch are in the key derivation because the server
 * stores these copies per device and epoch: binding them means it cannot hand
 * one device another's copy, or pass off an old epoch's key as the current
 * one. Both public keys are bound for the same reason as in ./link.ts.
 */

import { fromBase64Url, toBase64Url } from "./base64";
import { createEcdhKeypair, CURVE, ecdhAesKey, type EcdhKeypair } from "./ecdh";

export const DEVICE_SEAL_PREFIX = "d1";

const IV_BYTES = 12;

export type DeviceKeypair = EcdhKeypair;

/** A device keypair as written to a config file. Both base64url. */
export interface StoredDeviceKeypair {
  /** PKCS#8. Written only to files the device alone can read (0600). */
  privateKey: string;
  /** Raw uncompressed point. */
  publicKey: string;
}

export class DeviceSealError extends Error {}

/**
 * `extractable: true` where the key has to live in a file (the agent, the
 * tray); false where the platform can keep it, as IndexedDB does in a
 * browser -- there the page itself can never read the private key back.
 */
export function generateDeviceKeypair(
  extractable: boolean,
): Promise<DeviceKeypair> {
  return createEcdhKeypair(extractable);
}

export async function exportDeviceKeypair(
  keypair: DeviceKeypair,
): Promise<StoredDeviceKeypair> {
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    keypair.privateKey,
  )) as ArrayBuffer;
  return {
    privateKey: toBase64Url(new Uint8Array(pkcs8)),
    publicKey: keypair.publicKey,
  };
}

export async function importDeviceKeypair(
  stored: StoredDeviceKeypair,
): Promise<DeviceKeypair> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64Url(stored.privateKey),
    { name: "ECDH", namedCurve: CURVE },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKey: stored.publicKey };
}

function sealInfo(
  deviceId: string,
  epoch: number,
  devicePublicKey: string,
  ephemeralPublicKey: string,
): string {
  return `clipsync:device-seal:v1:${deviceId}:${epoch}:${devicePublicKey}:${ephemeralPublicKey}`;
}

/** Seal `vaultKey` so that only `device`, and only as epoch `epoch`, can open it. */
export async function sealVaultKeyForDevice(
  device: { deviceId: string; publicKey: string },
  epoch: number,
  vaultKey: string,
): Promise<string> {
  const ephemeral = await createEcdhKeypair(false);
  const key = await ecdhAesKey(
    ephemeral.privateKey,
    device.publicKey,
    sealInfo(device.deviceId, epoch, device.publicKey, ephemeral.publicKey),
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    fromBase64Url(vaultKey),
  );
  return [
    DEVICE_SEAL_PREFIX,
    ephemeral.publicKey,
    toBase64Url(iv),
    toBase64Url(new Uint8Array(ct)),
  ].join(".");
}

export async function openVaultKeyForDevice(
  keypair: DeviceKeypair,
  deviceId: string,
  epoch: number,
  sealed: string,
): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== DEVICE_SEAL_PREFIX) {
    throw new DeviceSealError("not a device-sealed vault key");
  }
  const [, ephemeralPublicKey, iv, ct] = parts as [string, string, string, string];
  try {
    const key = await ecdhAesKey(
      keypair.privateKey,
      ephemeralPublicKey,
      sealInfo(deviceId, epoch, keypair.publicKey, ephemeralPublicKey),
    );
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv) },
      key,
      fromBase64Url(ct),
    );
    return toBase64Url(new Uint8Array(raw));
  } catch {
    throw new DeviceSealError(
      "this sealed key is not for this device, or not for this epoch",
    );
  }
}
