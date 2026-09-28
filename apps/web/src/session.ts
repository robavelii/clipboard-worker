/**
 * Browser-side session state.
 *
 * Three stores on purpose:
 *   - credentials in localStorage, so the browser stays a paired device;
 *   - the vault keys in sessionStorage, so closing the tab drops them (or
 *     localStorage, if the device opts in -- see {@link cacheRing});
 *   - this device's keypair in IndexedDB, non-extractable, so a re-key can
 *     seal the new vault key to it. The page can use the private key but
 *     never read it back, so nothing in the page can leak it.
 * The passphrase is never stored and never sent anywhere.
 */

import type { Credentials } from "@clipsync/protocol";
import { generateDeviceKeypair, type DeviceKeypair, type VaultKey } from "@clipsync/crypto";
import { unlockVault } from "@clipsync/client/vault";
import { refreshVaultRing, registerDeviceKey } from "@clipsync/client/rekey";
import { ringOf, withKey, type VaultRing } from "@clipsync/client/ring";
import type { ApiClient } from "@clipsync/client";

const CREDS_KEY = "clipsync.credentials";
/** The vault keys by epoch, as a VaultRing in JSON. */
const RING_KEY = "clipsync.vaultRing";
/** A single vault key, written by builds from before key epochs. */
const LEGACY_KEY = "clipsync.vaultKey";

export function loadCredentials(): Credentials | null {
  const raw = localStorage.getItem(CREDS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Credentials;
  } catch {
    localStorage.removeItem(CREDS_KEY);
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

export function clearSession(): void {
  const creds = loadCredentials();
  localStorage.removeItem(CREDS_KEY);
  forgetVaultKey();
  if (creds) void forgetDeviceKey(creds.deviceId);
}

function parseRing(raw: string | null): VaultRing | null {
  if (!raw) return null;
  try {
    const ring = JSON.parse(raw) as VaultRing;
    return typeof ring.current === "number" && ring.keys?.[String(ring.current)]
      ? ring
      : null;
  } catch {
    return null;
  }
}

/** The vault keys cached for this device, if it is unlocked. */
export function cachedRing(): VaultRing | null {
  const ring =
    parseRing(sessionStorage.getItem(RING_KEY)) ??
    parseRing(localStorage.getItem(RING_KEY));
  if (ring) return ring;
  // Cached before key epochs existed, which makes it the epoch-0 key.
  const legacy = sessionStorage.getItem(LEGACY_KEY) ?? localStorage.getItem(LEGACY_KEY);
  return legacy ? ringOf(legacy, 0) : null;
}

export function isPersisted(): boolean {
  return localStorage.getItem(RING_KEY) !== null || localStorage.getItem(LEGACY_KEY) !== null;
}

/**
 * Cache the keys for this device.
 *
 * `persist` moves them to localStorage, which survives closing the tab. That
 * is a real weakening -- anyone who can unlock the phone can then read the
 * clipboard history -- but sharing into ClipSync opens a *new* tab every
 * time, so without it the share sheet would demand the passphrase on every
 * use and nobody would use it. Offered as an explicit choice rather than a
 * default. Left out, the keys stay wherever they already are.
 */
export function cacheRing(ring: VaultRing, persist = isPersisted()): void {
  forgetVaultKey();
  (persist ? localStorage : sessionStorage).setItem(RING_KEY, JSON.stringify(ring));
}

export function forgetVaultKey(): void {
  for (const store of [sessionStorage, localStorage]) {
    store.removeItem(RING_KEY);
    store.removeItem(LEGACY_KEY);
  }
}

/**
 * Expensive: runs PBKDF2, then unwraps or migrates the vault key.
 *
 * Fetches the wrapped key rather than trusting the one from enrolment: a
 * passphrase change or a re-key since then replaced it. Keys already cached
 * stay in the ring, so a device that missed a re-key keeps reading clips
 * not yet moved to the new key.
 */
export async function unlockWithPassphrase(
  api: ApiClient,
  passphrase: string,
  kdfSalt: string,
  enrolledWrappedKey: string | null,
  persist?: boolean,
): Promise<VaultRing> {
  const current = await api.vaultKey().catch(() => null);
  const { vaultKey } = await unlockVault(
    api,
    passphrase,
    kdfSalt,
    current ? current.wrappedVaultKey : enrolledWrappedKey,
  );
  const epoch = current?.keyEpoch ?? 0;
  const held = cachedRing();
  const ring = held ? withKey(held, epoch, vaultKey) : ringOf(vaultKey, epoch);
  cacheRing(ring, persist);
  return ring;
}

/** A key received on enrolment (invite, link): the only one this device holds. */
export function cacheEnrolmentKey(
  vaultKey: VaultKey,
  keyEpoch: number | undefined,
  persist?: boolean,
): VaultRing {
  const ring = ringOf(vaultKey, keyEpoch ?? 0);
  cacheRing(ring, persist);
  return ring;
}

/* ------------------------------ device key ------------------------------ */

const DB_NAME = "clipsync";
const STORE = "deviceKeys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * This device's keypair, created on first use. Keyed by device id, so
 * enrolling the browser again starts a fresh one.
 */
async function deviceKeypair(deviceId: string): Promise<DeviceKeypair> {
  const stored = await withStore<DeviceKeypair | undefined>("readonly", (s) =>
    s.get(deviceId),
  );
  if (stored) return stored;
  const created = await generateDeviceKeypair(false);
  await withStore("readwrite", (s) => s.put(created, deviceId));
  return created;
}

async function forgetDeviceKey(deviceId: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(deviceId)).catch(() => undefined);
}

/**
 * Register this browser's device key (idempotent), then pick up any re-key
 * it missed. Returns the ring to use, cached. Throws NoSealedKeyError when a
 * re-key left this device out; a passphrase unlock is then the way back.
 *
 * A browser without IndexedDB (some private modes) registers nothing and so
 * gets no sealed copy; it too falls back to the passphrase.
 */
export async function syncRing(
  api: ApiClient,
  deviceId: string,
  ring: VaultRing,
): Promise<VaultRing> {
  let keypair: DeviceKeypair | null = null;
  try {
    keypair = await deviceKeypair(deviceId);
    await registerDeviceKey(api, keypair.publicKey);
  } catch (err) {
    if (keypair) throw err; // the network, not IndexedDB
  }
  const next = await refreshVaultRing(api, keypair, deviceId, ring);
  if (next !== ring) cacheRing(next);
  return next;
}
