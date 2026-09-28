/**
 * The sync loop: watch the local clipboard, push encrypted changes, and apply
 * changes pushed by other devices.
 *
 * The whole design problem here is echo suppression. Writing a remote clip to
 * the local clipboard looks exactly like the user copying something, so
 * without care two devices will ping-pong a single copy forever. Two guards:
 *
 *   1. Events carry an `origin` device id; a device ignores its own.
 *   2. `lastHandled` records the hash of whatever content this agent last
 *      uploaded *or* applied, so the next poll recognises it and stays quiet.
 *
 * A third guard covers the gap between those two: a poll whose read started
 * before a remote clip was applied carries the *old* clipboard, and must not
 * push it -- see `applied`.
 */

import {
  MAX_ENVELOPE_BYTES,
  PING_FRAME,
  REVOKED_CLOSE_CODE,
  type ServerMessage,
} from "@clipsync/protocol";
import {
  dedupeHash,
  decryptText,
  encryptText,
  type VaultKeys,
} from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { detectClipboard, type ClipboardBackend } from "./clipboard";
import { resolveVaultKeys, type AgentConfig } from "./config";

const POLL_INTERVAL_MS = 600;
const PING_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface DaemonOptions {
  /** Push whatever is already on the clipboard when the agent starts. */
  pushCurrent?: boolean;
  verbose?: boolean;
  /**
   * Called once the server has made clear this device is revoked. The daemon
   * has already stopped; retrying would only hammer the API with a token
   * that will never work again.
   */
  onRevoked?: () => void;
}

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export class Daemon {
  private readonly api: ApiClient;
  private keys!: VaultKeys;
  private clipboard!: ClipboardBackend;

  /** Hash of the content this agent last uploaded or applied. */
  private lastHandled: string | null = null;

  /**
   * Bumped every time a remote clip is written to the local clipboard.
   *
   * A poll snapshots it before reading. If it moved by the time the read
   * returns, the read may predate the write -- it holds the clipboard as it
   * was, and pushing that would bump the old clip back to the top of history
   * and onto every other device's clipboard.
   */
  private applied = 0;

  /** One poll at a time: a slow read must not stack another behind it. */
  private polling = false;

  private socket: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly options: DaemonOptions = {},
  ) {
    this.api = new ApiClient(config.baseUrl, config.token);
  }

  async start(): Promise<void> {
    this.keys = await resolveVaultKeys(this.config, this.api);
    this.clipboard = await detectClipboard();

    log(
      `clipsync agent ready — device "${this.config.deviceName}" via ${this.clipboard.name}`,
    );

    // Prime the echo guard so a restart does not re-upload the clipboard the
    // user copied before the agent was running.
    const current = await this.readClipboard();
    if (current) {
      if (this.options.pushCurrent) {
        await this.push(current);
      } else {
        this.lastHandled = await dedupeHash(this.keys, current);
      }
    }

    this.connect();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close(1000, "shutdown");
    this.socket = null;
  }

  /* ---------------------------- local -> cloud --------------------------- */

  private async readClipboard(): Promise<string> {
    try {
      return await this.clipboard.read();
    } catch (err) {
      if (this.options.verbose) log("clipboard read failed:", err);
      return "";
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const generation = this.applied;
      const text = await this.readClipboard();
      if (!text) return;

      const hash = await dedupeHash(this.keys, text);
      // Stale: a remote clip landed while this read was in flight.
      if (generation !== this.applied) return;
      if (hash === this.lastHandled) return;

      await this.push(text, hash);
    } finally {
      this.polling = false;
    }
  }

  private async push(text: string, knownHash?: string): Promise<void> {
    const hash = knownHash ?? (await dedupeHash(this.keys, text));
    // Claim it before the await: a slow upload must not let the poller fire
    // again and push the same content twice.
    this.lastHandled = hash;

    try {
      const envelope = await encryptText(this.keys, text);
      if (envelope.length > MAX_ENVELOPE_BYTES) {
        log(`skipped ${text.length} chars — larger than the ${MAX_ENVELOPE_BYTES}B limit`);
        return;
      }

      const res = await this.api.createClip({
        type: "text",
        envelope,
        contentHash: hash,
        size: Buffer.byteLength(text, "utf8"),
      });

      if (!res.deduped) log(`pushed ${text.length} chars`);
    } catch (err) {
      if (this.isRevocation(err)) return;
      // Let the next poll retry: the clipboard still holds the content.
      this.lastHandled = null;
      log("push failed:", err instanceof Error ? err.message : err);
    }
  }

  /* ---------------------------- cloud -> local --------------------------- */

  private async apply(envelope: string, from: string): Promise<void> {
    try {
      const text = await decryptText(this.keys, envelope);
      // Set the guards before writing: the write itself triggers a clipboard
      // change that the poller will see, and a poll already in flight holds
      // the content this write replaces.
      this.lastHandled = await dedupeHash(this.keys, text);
      this.applied++;
      await this.clipboard.write(text);
      log(`applied ${text.length} chars from ${from}`);
    } catch (err) {
      log("apply failed:", err instanceof Error ? err.message : err);
    }
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "revoked":
        this.revoked();
        break;

      case "ready":
        log(
          msg.connected.length
            ? `connected — also online: ${msg.connected.join(", ")}`
            : "connected — no other devices online",
        );
        break;

      // A bump means another device copied something again; from here it is
      // indistinguishable from a new copy and belongs on the clipboard just
      // the same.
      case "clip.created":
      case "clip.bumped":
        // Defence in depth: the server already excludes the origin device.
        if (msg.origin === this.config.deviceId) break;
        void this.apply(msg.clip.envelope, msg.origin);
        break;

      case "device.connected":
        if (this.options.verbose) log(`device online: ${msg.deviceName}`);
        break;

      case "device.disconnected":
        if (this.options.verbose) log(`device offline: ${msg.deviceName}`);
        break;

      default:
        break;
    }
  }

  /* ----------------------------- transport ------------------------------ */

  private connect(): void {
    if (this.stopped) return;

    void (async () => {
      try {
        const url = await this.api.syncUrl();
        const ws = new WebSocket(url);
        this.socket = ws;

        ws.addEventListener("open", () => {
          this.reconnectDelay = RECONNECT_MIN_MS;
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
          }, PING_INTERVAL_MS);
        });

        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string") this.handleMessage(event.data);
        });

        ws.addEventListener("close", (event) => {
          if (this.pingTimer) clearInterval(this.pingTimer);
          if (event.code === REVOKED_CLOSE_CODE) {
            this.revoked();
            return;
          }
          this.scheduleReconnect();
        });

        ws.addEventListener("error", () => {
          // 'close' always follows; reconnect is handled there.
        });
      } catch (err) {
        if (this.isRevocation(err)) return;
        log("sync connect failed:", err instanceof Error ? err.message : err);
        this.scheduleReconnect();
      }
    })();
  }

  /**
   * A 401 means the token no longer resolves, which for a token that worked
   * at startup means this device was revoked. Stops the daemon if so.
   */
  private isRevocation(err: unknown): boolean {
    if (!(err instanceof ApiRequestError) || err.status !== 401) return false;
    this.revoked();
    return true;
  }

  private revoked(): void {
    if (this.stopped) return;
    log(
      "this device has been revoked -- stopping. Re-enrol with `clipsync link` or `clipsync login`.",
    );
    this.stop();
    this.options.onRevoked?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    if (this.options.verbose) log(`reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay).unref();
  }
}
