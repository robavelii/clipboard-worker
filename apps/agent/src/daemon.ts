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
 */

import {
  MAX_ENVELOPE_BYTES,
  PING_FRAME,
  type ServerMessage,
} from "@clipsync/protocol";
import {
  dedupeHash,
  decryptText,
  encryptText,
  type VaultKeys,
} from "@clipsync/crypto";
import { ApiClient } from "@clipsync/client";
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
    const text = await this.readClipboard();
    if (!text) return;

    const hash = await dedupeHash(this.keys, text);
    if (hash === this.lastHandled) return;

    await this.push(text, hash);
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
      // Let the next poll retry: the clipboard still holds the content.
      this.lastHandled = null;
      log("push failed:", err instanceof Error ? err.message : err);
    }
  }

  /* ---------------------------- cloud -> local --------------------------- */

  private async apply(envelope: string, from: string): Promise<void> {
    try {
      const text = await decryptText(this.keys, envelope);
      // Set the guard before writing: the write itself triggers a clipboard
      // change that the poller will see.
      this.lastHandled = await dedupeHash(this.keys, text);
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
      case "ready":
        log(
          msg.connected.length
            ? `connected — also online: ${msg.connected.join(", ")}`
            : "connected — no other devices online",
        );
        break;

      case "clip.created":
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

        ws.addEventListener("close", () => {
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.scheduleReconnect();
        });

        ws.addEventListener("error", () => {
          // 'close' always follows; reconnect is handled there.
        });
      } catch (err) {
        log("sync connect failed:", err instanceof Error ? err.message : err);
        this.scheduleReconnect();
      }
    })();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    if (this.options.verbose) log(`reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay).unref();
  }
}
