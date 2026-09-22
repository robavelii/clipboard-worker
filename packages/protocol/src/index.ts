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
}

export interface Clip {
  id: string;
  deviceId: string;
  type: ClipType;
  /** Opaque ciphertext envelope, `v1.<iv>.<ct>`. */
  envelope: string;
  /** HMAC of the plaintext under the user's dedupe key. Never a bare hash. */
  contentHash: string;
  /** Plaintext byte length, kept for UI display only. */
  size: number;
  pinned: boolean;
  createdAt: number;
  expiresAt: number | null;
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
}

export interface WhoAmI {
  userId: string;
  deviceId: string;
  deviceName: string;
  platform: Platform;
  kdfSalt: string;
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
}

export interface CreateClipResponse {
  id: string;
  createdAt: number;
  /** True when the server recognised this as a repeat of the newest clip. */
  deduped: boolean;
}

export interface ListClipsResponse {
  clips: Clip[];
  /** Pass back as `?before=` to page further into history. */
  nextCursor: number | null;
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
  | "clip.deleted"
  | "clip.pinned"
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

export interface ClipDeletedEvent extends SyncEventBase {
  type: "clip.deleted";
  clipId: string;
}

export interface ClipPinnedEvent extends SyncEventBase {
  type: "clip.pinned";
  clipId: string;
  pinned: boolean;
}

export interface DevicePresenceEvent extends SyncEventBase {
  type: "device.connected" | "device.disconnected";
  deviceId: string;
  deviceName: string;
}

export type SyncEvent =
  | ClipCreatedEvent
  | ClipDeletedEvent
  | ClipPinnedEvent
  | DevicePresenceEvent;

/**
 * Client -> server over the sync socket. Deliberately tiny: the server answers
 * the keepalive from the Durable Object hibernation auto-responder, so a ping
 * never wakes the object.
 */
export type ClientMessage = { type: "ping" };

export const PING_FRAME = JSON.stringify({ type: "ping" });

/** Server -> client control frames that are not domain events. */
export type ServerMessage =
  | SyncEvent
  | { type: "pong" }
  | { type: "ready"; deviceId: string; connected: string[] };

export function isSyncEvent(msg: ServerMessage): msg is SyncEvent {
  return msg.type !== "pong" && msg.type !== "ready";
}
