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
 *
 * A re-key changes the key every dedupe hash is taken under, so picking one
 * up (see `refresh`) re-primes those guards under the new key.
 *
 * Events are not queued for a device that is offline, so a reconnect also
 * catches up on the newest clip -- see `catchUp`.
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  MAX_ENVELOPE_BYTES,
  MAX_FILE_BYTES,
  PING_FRAME,
  REVOKED_CLOSE_CODE,
  R2_BUDGET_ERROR,
  STALE_EPOCH_ERROR,
  type Clip,
  type ServerMessage,
} from "@clipsync/protocol";
import {
  DecryptError,
  dedupeHash,
  sha256Hex,
  type DeviceKeypair,
} from "@clipsync/crypto";
import { downloadFile, uploadFile } from "@clipsync/client/files";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { NoSealedKeyError } from "@clipsync/client/rekey";
import {
  currentKeys,
  readClip,
  sealText,
  type OpenedClip,
  ringKeysFrom,
  type RingKeys,
  type VaultRing,
} from "@clipsync/client/ring";
import { detectClipboard, type ClipboardBackend, type ClipboardImage } from "./clipboard";
import {
  ensureDeviceKey,
  refreshRing,
  resolveVaultRing,
  storedRing,
  type AgentConfig,
} from "./config";
import { extensionFor, mimeFor } from "./mime";

const POLL_INTERVAL_MS = 600;
const PING_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * How old a clip missed while disconnected may be and still land on the
 * clipboard after a reconnect. Long enough for a laptop lid closed over a
 * copy on the phone; short enough that yesterday's clip never overwrites
 * whatever is on the clipboard now.
 */
const CATCH_UP_WINDOW_MS = 10 * 60 * 1000;
/**
 * The oldest authenticated copy time a clip may carry and still be applied.
 * A real copy reaches here in seconds; the slack is for clocks that
 * disagree and for catch-up, whose own window is the same.
 */
const REPLAY_WINDOW_MS = CATCH_UP_WINDOW_MS;

/**
 * Images and copied files are looked for only when the clipboard holds no
 * text, and only on every third poll (about 2 s): reading an image means
 * fetching and hashing the whole picture, which is not worth doing ten
 * times a second.
 */
const IMAGE_POLL_EVERY = 3;

/**
 * The largest image another device's copy puts on this clipboard, in bytes.
 * Anything bigger is still uploaded, up to MAX_FILE_BYTES, but stays in
 * history for the web UI or `clipsync get`, rather than every device
 * downloading it unasked.
 */
const MAX_CLIPBOARD_IMAGE_BYTES = 5 * 1024 * 1024;

/** Files sent from one copy in a file manager; a folder's worth is not a clip. */
const MAX_COPIED_FILES = 10;

const kb = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;

/** Echo-guard tags for images: their digest, apart from text's HMAC tags. */
const imageTag = (sha256: string) => `img:${sha256}`;

/**
 * Echo-guard tag for a copy of files with no text beside it (Windows
 * Explorer): the paths, sizes and times, so the same copy is sent once.
 */
async function filesTag(paths: string[]): Promise<string> {
  const seen = await Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => null);
      return [path, info?.size ?? null, info?.mtimeMs ?? null];
    }),
  );
  return `files:${await sha256Hex(new TextEncoder().encode(JSON.stringify(seen)))}`;
}

/** Tags that are plain digests, not keyed by the vault, and so survive a re-key. */
const isDigestTag = (tag: string) => tag.startsWith("img:") || tag.startsWith("files:");

/** A browser's "Copy image" in Firefox offers the image and its address as text. */
const isLoneUrl = (text: string) => /^https?:\/\/\S+$/.test(text.trim());

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
  /**
   * Called once the vault has been re-keyed without a copy for this device.
   * Like revocation, nothing short of enrolling again fixes it.
   */
  onStranded?: () => void;
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export class Daemon {
  private readonly api: ApiClient;
  /** Every vault key this device holds; clips are written under the current one. */
  private ring!: VaultRing;
  private keys!: RingKeys;
  private deviceKey: DeviceKeypair | null = null;
  /** One key refresh at a time; concurrent triggers share it. */
  private refreshing: Promise<void> | null = null;
  private clipboard!: ClipboardBackend;

  /** Hash of the content this agent last uploaded or applied. */
  private lastHandled: string | null = null;
  /** New content seen on the last poll, waiting to prove it has settled. */
  private candidate: string | null = null;

  /**
   * Bumped every time a remote clip is written to the local clipboard.
   *
   * A poll snapshots it before reading. If it moved by the time the read
   * returns, the read may predate the write -- it holds the clipboard as it
   * was, and pushing that would bump the old clip back to the top of history
   * and onto every other device's clipboard.
   */
  private applied = 0;

  /**
   * When the local clipboard last changed to something new, by this clock.
   * A clip missed while disconnected is older than that is stale news.
   */
  private localChangedAt = 0;
  /** Whether a socket has been ready before: the next ready is a reconnect. */
  private connectedBefore = false;

  /** Whether images sync through the clipboard (CLIPSYNC_IMAGES=off stops it). */
  private readonly images: boolean;
  /** Whether files copied in a file manager are sent (CLIPSYNC_FILES=off stops it). */
  private readonly files: boolean;
  private imageTick = 0;

  /** One poll at a time: a slow read must not stack another behind it. */
  private polling = false;

  private socket: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;

  constructor(
    private config: AgentConfig,
    private readonly options: DaemonOptions = {},
  ) {
    this.api = new ApiClient(config.baseUrl, config.token);
    const off = (value: string | undefined) => /^(0|off|false|no)$/i.test(value ?? "");
    this.images = !off(process.env.CLIPSYNC_IMAGES);
    this.files = !off(process.env.CLIPSYNC_FILES);
  }

  async start(): Promise<void> {
    this.ring = await resolveVaultRing(this.config, this.api);
    this.keys = await ringKeysFrom(this.ring, this.config.kdfSalt);
    this.clipboard = await detectClipboard();

    // Register this device's key so a re-key can reach it, then catch up on
    // any re-key that happened while the agent was not running.
    try {
      const ensured = await ensureDeviceKey(this.config, this.api);
      this.config = ensured.config;
      this.deviceKey = ensured.keypair;
    } catch (err) {
      if (this.isRevocation(err)) return;
      log("could not register this device's key:", err instanceof Error ? err.message : err);
    }
    if (storedRing(this.config)) await this.refresh();
    if (this.stopped) return;

    log(
      `clipsync agent ${__CLIPSYNC_BUILD__} ready — device "${this.config.deviceName}" via ${this.clipboard.name}`,
    );

    // Prime the echo guard so a restart does not re-upload the clipboard the
    // user copied before the agent was running.
    const current = await this.readClipboard();
    if (current) {
      if (this.options.pushCurrent) {
        await this.push(current);
      } else {
        this.lastHandled = await dedupeHash(currentKeys(this.keys), current);
      }
    } else {
      const files = await this.readFilesWithoutText();
      const image = files.length ? null : await this.readImage();
      if (files.length) this.lastHandled = await filesTag(files);
      else if (image) this.lastHandled = imageTag(await sha256Hex(image.bytes));
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
    this.clipboard?.close?.();
  }

  /* ---------------------------- local -> cloud --------------------------- */

  private async readFiles(): Promise<string[]> {
    if (!this.files || !this.clipboard.readFiles) return [];
    try {
      return await this.clipboard.readFiles();
    } catch (err) {
      if (this.options.verbose) log("clipboard file read failed:", err);
      return [];
    }
  }

  /** Files on a clipboard that holds no text, where a file copy can. */
  private async readFilesWithoutText(): Promise<string[]> {
    return this.clipboard.filesOfferText ? [] : this.readFiles();
  }

  private async readImage(): Promise<ClipboardImage | null> {
    if (!this.images || !this.clipboard.readImage) return null;
    try {
      return await this.clipboard.readImage();
    } catch (err) {
      if (this.options.verbose) log("clipboard image read failed:", err);
      return null;
    }
  }

  private async readClipboard(): Promise<string> {
    try {
      return await this.clipboard.read();
    } catch (err) {
      if (this.options.verbose) log("clipboard read failed:", err);
      return "";
    }
  }

  /**
   * Push clipboard content once it has held for two consecutive polls.
   *
   * Some copies are several writes in quick succession -- clipboard managers
   * re-owning the selection, apps that set plain text and then rich text, a
   * quick copy corrected by a second one. Waiting one interval (0.6-1.2s in
   * all) means only the value that stuck is uploaded, rather than every
   * intermediate one landing on the other devices and in history.
   */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const generation = this.applied;
      const text = await this.readClipboard();
      if (!text) {
        await this.pollBinary(generation);
        return;
      }

      const hash = await dedupeHash(currentKeys(this.keys), text);
      // Stale: a remote clip landed while this read was in flight, so the
      // read holds what the clipboard *was* -- not even a candidate.
      if (generation !== this.applied) return;
      if (!this.settled(hash)) return;

      // New content has settled. Its text may only stand for what was really
      // copied: files in a file manager read as their paths (or, from Finder,
      // their names), and Firefox's "Copy image" as the image's address.
      // Checked once per copy, not per poll, so the extra reads cost nothing.
      const files = await this.readFiles();
      if (generation !== this.applied) return;
      if (files.length) {
        await this.pushFiles(files, hash);
        return;
      }
      if (isLoneUrl(text)) {
        const image = await this.readImage();
        if (generation !== this.applied) return;
        if (image) {
          await this.pushImage(image, hash);
          return;
        }
      }
      await this.push(text, hash);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The settle rule, for text, images and files alike: true once `tag` has
   * been read on two polls in a row and is not what this agent last pushed
   * or applied.
   */
  private settled(tag: string): boolean {
    if (tag === this.lastHandled) {
      this.candidate = null;
      return false;
    }
    if (tag !== this.candidate) {
      this.candidate = tag;
      this.localChangedAt = Date.now();
      return false;
    }
    this.candidate = null;
    return true;
  }

  /**
   * poll() for a clipboard with no text: copied files (Windows Explorer
   * offers no text for them), else an image, keyed by digest.
   */
  private async pollBinary(generation: number): Promise<void> {
    if (++this.imageTick % IMAGE_POLL_EVERY !== 0) return;

    const files = await this.readFilesWithoutText();
    if (generation !== this.applied) return;
    if (files.length) {
      const tag = await filesTag(files);
      if (this.settled(tag)) await this.pushFiles(files, tag);
      return;
    }

    const image = await this.readImage();
    if (!image || generation !== this.applied) return;
    const tag = imageTag(await sha256Hex(image.bytes));
    if (this.settled(tag)) await this.pushImage(image, tag);
  }

  private async pushImage(image: ClipboardImage, tag: string): Promise<void> {
    this.lastHandled = tag;
    if (image.bytes.length > MAX_FILE_BYTES) {
      log(`skipped a ${kb(image.bytes.length)} image -- over the ${kb(MAX_FILE_BYTES)} file limit`);
      return;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const res = await uploadFile(this.api, this.keys, this.config.userId, this.config.deviceId, {
        name: `image-${stamp}.${extensionFor(image.mime)}`,
        mime: image.mime,
        bytes: image.bytes,
      });
      if (!res.deduped) log(`pushed an image (${kb(image.bytes.length)})`);
    } catch (err) {
      await this.uploadFailed(err, tag, "image push");
    }
  }

  /**
   * Send files copied in a file manager, each as `clipsync send` would.
   * Folders are skipped: a clip is a file, not a tree.
   */
  private async pushFiles(paths: string[], tag: string): Promise<void> {
    this.lastHandled = tag;
    const picked = paths.slice(0, MAX_COPIED_FILES);
    if (paths.length > picked.length) {
      log(`copied ${paths.length} files -- sending the first ${picked.length}`);
    }
    for (const path of picked) {
      const name = basename(path);
      let bytes: Uint8Array;
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          log(`skipped ${name} -- only files are sent, not folders`);
          continue;
        }
        if (info.size === 0) continue;
        if (info.size > MAX_FILE_BYTES) {
          log(`skipped ${name} (${kb(info.size)}) -- over the ${kb(MAX_FILE_BYTES)} file limit`);
          continue;
        }
        bytes = new Uint8Array(await readFile(path));
      } catch (err) {
        log(`could not read ${name}:`, err instanceof Error ? err.message : err);
        continue;
      }
      try {
        const res = await uploadFile(this.api, this.keys, this.config.userId, this.config.deviceId, {
          name,
          mime: mimeFor(name),
          bytes,
        });
        if (!res.deduped) log(`pushed ${name} (${kb(bytes.length)})`);
      } catch (err) {
        // The rest would fail the same way; a retry sends them all again,
        // and the ones already in history just move to the top.
        await this.uploadFailed(err, tag, `sending ${name}`);
        return;
      }
    }
  }

  /** After a failed image or file upload: retry on a later poll, or not. */
  private async uploadFailed(err: unknown, tag: string, what: string): Promise<void> {
    if (this.isRevocation(err)) return;
    this.lastHandled = null;
    if (err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR) {
      await this.refresh();
      return;
    }
    // Past the R2 budget the next poll would only be refused again.
    if (err instanceof ApiRequestError && err.code === R2_BUDGET_ERROR) {
      this.lastHandled = tag;
    }
    log(`${what} failed:`, err instanceof Error ? err.message : err);
  }

  private async push(text: string, knownHash?: string): Promise<void> {
    const keys = this.keys;
    const hash = knownHash ?? (await dedupeHash(currentKeys(keys), text));
    // Claim it before the await: a slow upload must not let the poller fire
    // again and push the same content twice.
    this.lastHandled = hash;

    try {
      const sealed = await sealText(keys, this.config.userId, this.config.deviceId, text);
      if (sealed.envelope.length > MAX_ENVELOPE_BYTES) {
        log(`skipped ${text.length} chars — larger than the ${MAX_ENVELOPE_BYTES}B limit`);
        return;
      }

      const res = await this.api.createClip(sealed);

      if (!res.deduped) log(`pushed ${text.length} chars`);
    } catch (err) {
      if (this.isRevocation(err)) return;
      // Let the next poll retry: the clipboard still holds the content.
      this.lastHandled = null;
      if (err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR) {
        // The vault was re-keyed while this device was not listening. Pick
        // up the new key; the next poll pushes under it.
        await this.refresh();
        return;
      }
      log("push failed:", err instanceof Error ? err.message : err);
    }
  }

  /* ---------------------------- cloud -> local --------------------------- */

  /**
   * Open a clip, picking up a re-key first if it was written under a key
   * this device does not hold yet (the vault.rotated event may still be on
   * its way, or was missed). null for a clip too old to be a new copy.
   */
  private async openFresh(clip: Clip, from: string): Promise<OpenedClip | null> {
    let opened: OpenedClip;
    try {
      opened = await readClip(this.keys, clip, this.config.userId);
    } catch (err) {
      if (!(err instanceof DecryptError) || clip.keyEpoch <= this.keys.current) {
        throw err;
      }
      await this.refresh();
      opened = await readClip(this.keys, clip, this.config.userId);
    }
    // The copy time is authenticated (v2), so an old clip cannot be passed
    // off as a new copy: the server could otherwise replay last week's clip
    // onto every clipboard. v1 clips carry no time to check.
    if (opened.copiedAt !== null && Date.now() - opened.copiedAt > REPLAY_WINDOW_MS) {
      const minutes = Math.round((Date.now() - opened.copiedAt) / 60_000);
      log(`ignored a clip from ${from} copied ${minutes} min ago -- too old to be a new copy`);
      return null;
    }
    return opened;
  }

  private async apply(clip: Clip, from: string): Promise<void> {
    if (clip.type === "image" && this.images && this.clipboard.writeImage) {
      await this.applyImage(clip, from);
      return;
    }
    // Files, and images where they do not sync, stay in history (`clipsync
    // get`, the web UI) rather than every device downloading them unasked.
    if (clip.type !== "text") {
      if (this.options.verbose) log(`${clip.type} from ${from} -- in history, not applied`);
      return;
    }
    try {
      const opened = await this.openFresh(clip, from);
      if (!opened) return;
      const { text } = opened;
      // Set the guards before writing: the write itself triggers a clipboard
      // change that the poller will see, and a poll already in flight holds
      // the content this write replaces.
      this.lastHandled = await dedupeHash(currentKeys(this.keys), text);
      this.applied++;
      // Whatever was waiting to settle has just been overwritten.
      this.candidate = null;
      await this.clipboard.write(text);
      log(`applied ${text.length} chars from ${from}`);
    } catch (err) {
      log("apply failed:", err instanceof Error ? err.message : err);
    }
  }

  private async applyImage(clip: Clip, from: string): Promise<void> {
    try {
      const opened = await this.openFresh(clip, from);
      const meta = opened?.file;
      if (!meta) return;
      if (!this.clipboard.imageTypes?.includes(meta.mime) || meta.size > MAX_CLIPBOARD_IMAGE_BYTES) {
        log(`image from ${from} (${kb(meta.size)}) is in history, not applied`);
        return;
      }
      // Already here: this device copied it, or has applied it before.
      if (imageTag(meta.sha256) === this.lastHandled) return;

      const { bytes } = await downloadFile(this.api, this.keys, clip, this.config.userId);
      this.lastHandled = imageTag(meta.sha256);
      this.applied++;
      this.candidate = null;
      await this.clipboard.writeImage!({ bytes, mime: meta.mime });
      // What the clipboard hands back may not be these bytes -- Windows
      // re-encodes every image as PNG -- and the poller must recognise that
      // as this image.
      const back = await this.readImage();
      if (back) this.lastHandled = imageTag(await sha256Hex(back.bytes));
      log(`applied an image (${kb(bytes.length)}) from ${from}`);
    } catch (err) {
      log("image apply failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * After a reconnect, apply the newest clip if it arrived while this device
   * was not listening: another device's, recent, newer than anything copied
   * here since, and not already what this clipboard holds. Only the newest --
   * replaying every missed clip would just flicker the clipboard through
   * them, and history holds the rest.
   *
   * Not on first start: a restart (a rebuild, a login) must not replace what
   * the user copied while the agent was down.
   */
  private async catchUp(): Promise<void> {
    try {
      const {
        clips: [newest],
      } = await this.api.listClips(1);
      if (!newest || newest.deviceId === this.config.deviceId) return;
      if (Date.now() - newest.createdAt > CATCH_UP_WINDOW_MS) return;
      if (newest.createdAt <= this.localChangedAt) return;
      if (newest.keyEpoch === this.keys.current && newest.contentHash === this.lastHandled) {
        return;
      }
      // (An image already on the clipboard is recognised by applyImage.)
      await this.apply(newest, `${newest.deviceId} (missed while offline)`);
    } catch (err) {
      if (this.isRevocation(err)) return;
      log("catch-up failed:", err instanceof Error ? err.message : err);
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
        if (this.connectedBefore) void this.catchUp();
        this.connectedBefore = true;
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
        void this.apply(msg.clip, msg.origin);
        break;

      case "vault.rotated":
        void this.refresh();
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

  /**
   * Pick up a re-key: add the new vault key to the ring and write under it
   * from now on. Concurrent triggers (the event, a 409, an unreadable clip)
   * share one fetch.
   */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const before = this.ring.current;
        const next = await refreshRing(this.config, this.api, this.deviceKey, this.ring);
        this.config = next.config;
        this.ring = next.ring;
        if (next.ring.current === before) return;

        this.keys = await ringKeysFrom(next.ring, this.config.kdfSalt);
        // Dedupe tags are keyed per epoch, so every hash taken so far is
        // meaningless now. Re-prime the echo guard under the new key rather
        // than let the next poll push the clipboard back as if it were new.
        this.applied++;
        this.candidate = null;
        // Image and file tags are digests, not keyed: they survive a re-key.
        if (this.lastHandled !== null && !isDigestTag(this.lastHandled)) {
          const current = await this.readClipboard();
          this.lastHandled = current
            ? await dedupeHash(currentKeys(this.keys), current)
            : null;
        }
        log(`vault re-keyed -- now writing under epoch ${next.ring.current}`);
      } catch (err) {
        if (this.isRevocation(err)) return;
        if (err instanceof NoSealedKeyError) {
          this.stranded(err.message);
          return;
        }
        log("could not fetch the new vault key:", err instanceof Error ? err.message : err);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private stranded(message: string): void {
    if (this.stopped) return;
    log(`${message} -- stopping.`);
    this.stop();
    this.options.onStranded?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    if (this.options.verbose) log(`reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay).unref();
  }
}
