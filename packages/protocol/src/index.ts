/**
 * Shared wire contract between the Worker, the desktop agent and the web UI.
 *
 * Everything the server sees is ciphertext. `envelope` is an opaque string
 * produced by @clipsync/crypto; the server never parses it.
 */

export const PROTOCOL_VERSION = 1;

/** Max size of a single encrypted envelope accepted by the API (bytes). */
export const MAX_ENVELOPE_BYTES = 256 * 1024;

/** How long a clip lives before the purge cron removes it (unless pinned). */
export const DEFAULT_TTL_DAYS = 30;

/** Most clips one re-encryption request may carry. */
export const MAX_REENCRYPT_BATCH = 50;

/**
 * ApiError.error when a clip is written under a vault key the account has
 * rotated away from. The client should fetch its sealed copy of the new key
 * (GET /api/vault/sealed) and write again.
 */
export const STALE_EPOCH_ERROR = "stale_epoch";

export type ClipType = "text";

export type Platform = "linux" | "macos" | "windows" | "web" | "other";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  createdAt: number;
  lastSeen: number | null;
  /** True while the device holds an open sync WebSocket. */
  online?: boolean;
  /**
   * The device's long-term ECDH public key, raw P-256 point, base64url. A
   * re-key seals the new vault key to it. null until the device registers one.
   */
  publicKey: string | null;
}

export interface Clip {
  id: string;
  deviceId: string;
  type: ClipType;
  /**
   * Ciphertext envelope. `v2.<header>.<iv>.<ct>` binds the copying device,
   * copy time and type to the ciphertext (clients check them against this
   * row); legacy `v1.<iv>.<ct>` carries nothing but the text.
   */
  envelope: string;
  /** HMAC of the plaintext under the user's dedupe key. Never a bare hash. */
  contentHash: string;
  /** Plaintext byte length, kept for UI display only. */
  size: number;
  pinned: boolean;
  createdAt: number;
  expiresAt: number | null;
  /** Which vault key encrypted this clip: the account's epoch when written. */
  keyEpoch: number;
}

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

export interface BootstrapRequest {
  adminSecret: string;
  deviceName: string;
  platform: Platform;
}

export interface PairRequest {
  code: string;
  deviceName: string;
  platform: Platform;
}

/** Returned by bootstrap and pair. `kdfSalt` is public; the passphrase is not. */
export interface Credentials {
  userId: string;
  deviceId: string;
  token: string;
  kdfSalt: string;
  /**
   * The account's vault key, sealed under the passphrase. null on an account
   * that predates it -- the first device to unlock writes it.
   */
  wrappedVaultKey: string | null;
  /**
   * True when this call created the account. The caller uses it to decide
   * between a fresh random vault key and the one implied by the old
   * passphrase-derived scheme.
   */
  createdAccount?: boolean;
  /**
   * The account's current vault key epoch. Optional because credentials
   * stored by older clients lack it; read it as 0 when absent.
   */
  keyEpoch?: number;
}

/**
 * Write the wrapped vault key: the first wrap (new or migrated account), or a
 * passphrase change.
 */
export interface PutVaultKeyRequest {
  wrappedVaultKey: string;
  /** authHashOf() the proof for the passphrase this key is now wrapped under. */
  authHash: string;
  /**
   * Proof of the *current* passphrase. Required to replace a key that is
   * already set; a device holding only the vault key cannot produce it.
   */
  authProof?: string;
  /**
   * The epoch of the key being re-wrapped. When set, the write lands only if
   * the vault is still at it, so a passphrase change racing a re-key cannot
   * put the old key back (409 stale_epoch).
   */
  keyEpoch?: number;
}

/** Register the passphrase proof on an account that predates it. */
export interface ClaimVaultAuthRequest {
  authHash: string;
}

export interface ClaimVaultAuthResponse {
  /** false when this same hash was already registered. */
  claimed: boolean;
}

export interface VaultKeyResponse {
  kdfSalt: string;
  wrappedVaultKey: string | null;
  /** The epoch `wrappedVaultKey` belongs to. */
  keyEpoch: number;
}

/* ------------------------- device keys and re-key ------------------------ */

export interface SetDeviceKeyRequest {
  /** Raw P-256 point, base64url. */
  publicKey: string;
}

/** This device's sealed copy of the current vault key, if one was made. */
export interface SealedVaultKeyResponse {
  epoch: number;
  /** "d1." envelope, or null when the re-key did not seal one for this device. */
  sealed: string | null;
}

export interface SealedKeyEntry {
  deviceId: string;
  sealed: string;
}

/**
 * Move the account to a fresh vault key. Only a passphrase holder can: the
 * request carries the current passphrase's proof, like a passphrase change.
 */
export interface RotateVaultRequest {
  /** The epoch being retired. Refused if the account has moved on. */
  fromEpoch: number;
  authProof: string;
  /** Proof hash for the passphrase the new key is wrapped under. */
  authHash: string;
  /** The new vault key, wrapped under the passphrase. */
  wrappedVaultKey: string;
  /** The new vault key sealed to each device that should keep reading. */
  sealedKeys: SealedKeyEntry[];
}

export interface RotateVaultResponse {
  epoch: number;
  /** Active devices that got no sealed copy: they must be enrolled again. */
  unsealed: string[];
}

export interface ReencryptItem {
  id: string;
  /** The epoch the clip is stored under now; the write is refused otherwise. */
  fromEpoch: number;
  envelope: string;
  contentHash: string;
}

export interface ReencryptClipsRequest {
  items: ReencryptItem[];
}

export interface ReencryptClipsResponse {
  updated: number;
  epoch: number;
}

export interface WhoAmI {
  userId: string;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  kdfSalt: string;
  wrappedVaultKey: string | null;
  keyEpoch: number;
}

export interface PairCodeResponse {
  code: string;
  expiresAt: number;
}

export interface CreateClipRequest {
  type: ClipType;
  envelope: string;
  contentHash: string;
  size: number;
  /** The epoch of the key that encrypted it. Omitted by older clients: 0. */
  keyEpoch?: number;
}

export interface CreateClipResponse {
  id: string;
  createdAt: number;
  /** True when the server recognised this as a repeat of the newest clip. */
  deduped: boolean;
}

export interface ListClipsResponse {
  clips: Clip[];
  /**
   * Pass back as `?before=` to page further into history. Opaque: currently
   * `<createdAt>.<id>`, so clips sharing a millisecond are not skipped.
   * Workers before that sent a bare timestamp.
   */
  nextCursor: string | number | null;
}

/* --------------------------- device linking ---------------------------- */

export interface LinkRequest {
  /** Joining device's ephemeral ECDH public key, raw point, base64url. */
  publicKey: string;
  deviceName: string;
  platform: Platform;
}

export interface LinkRequestResponse {
  linkId: string;
  /** Proves ownership of the request when claiming. Shown to nobody else. */
  pickupToken: string;
  expiresAt: number;
}

export interface LinkStatusResponse {
  linkId: string;
  publicKey: string;
  deviceName: string;
  platform: Platform;
  createdAt: number;
  expiresAt: number;
}

export interface LinkApproveRequest {
  approverPublicKey: string;
  /** AES-GCM envelope of the vault passphrase under the ECDH shared key. */
  wrappedSecret: string;
}

export type LinkClaimResponse =
  | { status: "pending" }
  | {
      status: "approved";
      approverPublicKey: string;
      wrappedSecret: string;
      credentials: Credentials;
    };

/* ------------------------- scan-to-join invites ------------------------ */

export interface CreateInviteRequest {
  /** Vault key sealed under a key derived from the QR secret. */
  sealedVaultKey: string;
  /** SHA-256 of the QR secret, so the id alone cannot enrol a device. */
  proofHash: string;
}

export interface CreateInviteResponse {
  inviteId: string;
  expiresAt: number;
}

export interface ClaimInviteRequest {
  /** SHA-256 of the QR secret. The secret itself never leaves the scanner. */
  proof: string;
  deviceName: string;
  platform: Platform;
}

export interface ClaimInviteResponse {
  sealedVaultKey: string;
  credentials: Credentials;
}

export interface TicketResponse {
  ticket: string;
  expiresAt: number;
}

export interface ApiError {
  error: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Sync events (Durable Object -> clients)                             */
/* ------------------------------------------------------------------ */

export type SyncEventType =
  | "clip.created"
  | "clip.bumped"
  | "clip.deleted"
  | "clip.pinned"
  | "vault.rotated"
  | "device.connected"
  | "device.disconnected";

interface SyncEventBase {
  version: typeof PROTOCOL_VERSION;
  eventId: string;
  /** Device that caused the event. Receivers MUST ignore their own events. */
  origin: string;
  timestamp: number;
}

export interface ClipCreatedEvent extends SyncEventBase {
  type: "clip.created";
  clip: Clip;
}

/**
 * An existing clip was copied again, so it moves back to the top.
 *
 * Carries the whole clip because receivers need to do exactly what they do for
 * a new one -- a device that re-copies an old clip still expects it on its
 * other devices' clipboards.
 */
export interface ClipBumpedEvent extends SyncEventBase {
  type: "clip.bumped";
  clip: Clip;
}

export interface ClipDeletedEvent extends SyncEventBase {
  type: "clip.deleted";
  clipId: string;
}

export interface ClipPinnedEvent extends SyncEventBase {
  type: "clip.pinned";
  clipId: string;
  pinned: boolean;
}

/**
 * The account moved to a new vault key. Fetch this device's sealed copy; a
 * device that was not given one (revoked, or never registered a key) cannot.
 */
export interface VaultRotatedEvent extends SyncEventBase {
  type: "vault.rotated";
  epoch: number;
}

export interface DevicePresenceEvent extends SyncEventBase {
  type: "device.connected" | "device.disconnected";
  deviceId: string;
  deviceName: string;
}

export type SyncEvent =
  | ClipCreatedEvent
  | ClipBumpedEvent
  | ClipDeletedEvent
  | ClipPinnedEvent
  | VaultRotatedEvent
  | DevicePresenceEvent;

/**
 * Client -> server over the sync socket. Deliberately tiny: the server answers
 * the keepalive from the Durable Object hibernation auto-responder, so a ping
 * never wakes the object.
 */
export type ClientMessage = { type: "ping" };

export const PING_FRAME = JSON.stringify({ type: "ping" });

/**
 * Close code the server uses when it drops a revoked device's socket. In the
 * 4000-4999 range reserved for applications, so a client can tell "you were
 * revoked, stop" apart from an ordinary disconnect it should retry.
 *
 * Clients should also act on the `revoked` frame sent just before the close:
 * a close event is not reliably observable (see SyncRoom.disconnect).
 */
export const REVOKED_CLOSE_CODE = 4001;

/** Server -> client control frames that are not domain events. */
export type ServerMessage =
  | SyncEvent
  | { type: "pong" }
  | { type: "ready"; deviceId: string; connected: string[] }
  /** This device was revoked. The socket closes next; do not reconnect. */
  | { type: "revoked" };

export function isSyncEvent(msg: ServerMessage): msg is SyncEvent {
  return msg.type !== "pong" && msg.type !== "ready" && msg.type !== "revoked";
}
