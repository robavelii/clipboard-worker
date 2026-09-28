/**
 * The tray panel.
 *
 * Needs no setup of its own: it takes the vault keys from the agent's config
 * and enrols itself as a device on first run, so if `clipsync` works on this
 * machine the panel does too. It registers a device key of its own, so a
 * re-key reaches it whether or not the agent is running. Everything below that is the same client, the
 * same crypto and the same hooks the web UI uses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import type { Platform, SyncEvent } from "@clipsync/protocol";
import {
  exportDeviceKeypair,
  generateDeviceKeypair,
  importDeviceKeypair,
  type DeviceKeypair,
  type StoredDeviceKeypair,
} from "@clipsync/crypto";
import { NoSealedKeyError, refreshVaultRing, registerDeviceKey } from "@clipsync/client/rekey";
import {
  ringKeysFrom,
  ringOf,
  withKey,
  type RingKeys,
  type VaultRing,
} from "@clipsync/client/ring";
import { useClips, useSync, type DecryptedClip } from "@clipsync/react";

/** Records to a file the packaged app can write; see log_debug in lib.rs. */
function debugLog(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}`;
  void invoke("log_debug", { line }).catch(() => {});
}

/** Roughly what overflows the three collapsed lines of a clip. */
function isLong(text: string | null): boolean {
  return text !== null && (text.length > 120 || text.split("\n").length > 3);
}

/** WebKit reports every failed fetch as "Load failed", which says nothing. */
function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message === "Load failed"
      ? "Could not reach the server. Check that the machine is online and that the Worker URL in ~/.config/clipsync/config.json is correct."
      : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/** The panel's own device, enrolled on first run; see enrolTray. */
interface TrayConfig {
  baseUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
  /** Its keypair; a re-key seals the new vault key to the public half. */
  deviceKey?: StoredDeviceKeypair;
  /** Vault keys the panel fetched itself after a re-key, by epoch. */
  vaultKeys?: Record<string, string>;
  /** Anything else in tray.json (the shortcut) is kept as it is. */
  [other: string]: unknown;
}

async function saveTray(tray: TrayConfig): Promise<void> {
  await invoke("save_tray_config", { json: JSON.stringify(tray, null, 2) });
}

function currentPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

/**
 * Enrol the panel as a device of its own, vouched for by the agent.
 *
 * The Worker never echoes an event to the device that sent it, so a panel
 * sharing the agent's device would never see anything copied on this
 * machine. A separate device gets those events live like any other.
 *
 * The agent mints a pairing code and the panel redeems it at once -- the
 * same flow as `clipsync pair`, minus the typing. No passphrase is needed:
 * the vault key comes from the agent's config.
 */
async function enrolTray(agent: AgentConfig): Promise<TrayConfig> {
  const agentApi = new ApiClient(agent.baseUrl, agent.token, tauriFetch);
  const { code } = await agentApi.pairCode();
  const deviceName = `${agent.deviceName} (tray)`.slice(0, 64);
  const creds = await new ApiClient(agent.baseUrl, undefined, tauriFetch).pair(
    code,
    deviceName,
    currentPlatform(),
  );
  const tray: TrayConfig = {
    baseUrl: agent.baseUrl,
    deviceId: creds.deviceId,
    deviceName,
    token: creds.token,
  };
  await saveTray(tray);
  return tray;
}

/** The panel's credentials, enrolling first if it has none for this Worker. */
async function trayConfigFor(agent: AgentConfig): Promise<TrayConfig> {
  const saved = await invoke<string | null>("load_tray_config");
  const tray = saved ? (JSON.parse(saved) as TrayConfig) : null;
  // A tray enrolled against another Worker (after `clipsync login --url`
  // elsewhere) holds a token this one has never heard of.
  if (tray && tray.baseUrl === agent.baseUrl) return tray;
  debugLog("boot: enrolling tray device");
  return enrolTray(agent);
}

interface AgentConfig {
  baseUrl: string;
  /** The account; envelopes are bound to it. */
  userId: string;
  token: string;
  kdfSalt: string;
  deviceName: string;
  /** The current key. Older agents write only this. */
  vaultKey?: string;
  vaultKeys?: Record<string, string>;
  keyEpoch?: number;
}

/** Every key the agent and the panel hold between them. */
function ringFrom(agent: AgentConfig, tray: TrayConfig): VaultRing | null {
  let ring: VaultRing | null = agent.vaultKeys && Object.keys(agent.vaultKeys).length
    ? { current: agent.keyEpoch ?? 0, keys: agent.vaultKeys }
    : agent.vaultKey
      ? ringOf(agent.vaultKey, agent.keyEpoch ?? 0)
      : null;
  if (!ring) return null;
  for (const [epoch, key] of Object.entries(tray.vaultKeys ?? {})) {
    ring = withKey(ring, Number(epoch), key);
  }
  return ring;
}

/** The panel's keypair, created and saved on first use. */
async function trayKeypair(tray: TrayConfig): Promise<{ tray: TrayConfig; keypair: DeviceKeypair }> {
  if (tray.deviceKey) {
    return { tray, keypair: await importDeviceKeypair(tray.deviceKey) };
  }
  const keypair = await generateDeviceKeypair(true);
  const next = { ...tray, deviceKey: await exportDeviceKeypair(keypair) };
  await saveTray(next);
  return { tray: next, keypair };
}

/**
 * Pick up a re-key through the panel's own sealed copy, saving it to
 * tray.json. The agent's config catches up whenever the agent next runs.
 */
async function refreshTrayRing(
  api: ApiClient,
  tray: TrayConfig,
  keypair: DeviceKeypair,
  ring: VaultRing,
): Promise<{ tray: TrayConfig; ring: VaultRing }> {
  const next = await refreshVaultRing(api, keypair, tray.deviceId, ring);
  if (next === ring) return { tray, ring };
  const saved = { ...tray, vaultKeys: { ...tray.vaultKeys, [String(next.current)]: next.keys[String(next.current)]! } };
  await saveTray(saved);
  return { tray: saved, ring: next };
}

function strandedMessage(): string {
  return "The vault was re-keyed without a copy for this panel. Delete ~/.config/clipsync/tray.json and reopen to enrol it again.";
}

/**
 * Shown whether the revocation is found at startup or arrives while the panel
 * is running (the sync hook then reports status "revoked" and stops).
 */
function revokedMessage(deviceName: string): string {
  return `The panel's device "${deviceName}" was revoked. To use it again, delete ~/.config/clipsync/tray.json and reopen.`;
}

type Boot =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      api: ApiClient;
      ring: VaultRing;
      kdfSalt: string;
      account: string;
      keypair: DeviceKeypair;
      tray: TrayConfig;
    };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        debugLog(`boot: build ${__CLIPSYNC_BUILD__}, reading agent config`);
        const config = JSON.parse(
          await invoke<string>("load_agent_config"),
        ) as AgentConfig;
        debugLog("boot: config ok", { baseUrl: config.baseUrl, device: config.deviceName });

        let tray = await trayConfigFor(config);
        let ring = ringFrom(config, tray);
        if (!ring) {
          throw new Error(
            "This machine's agent has no vault key yet. Run `clipsync status` once, then reopen.",
          );
        }
        const api = new ApiClient(tray.baseUrl, tray.token, tauriFetch);

        // Prove the network path before rendering a list that would otherwise
        // fail with WebKit's opaque "Load failed".
        try {
          await api.me();
        } catch (err) {
          // Revoked from another device. Enrolling again here would quietly
          // undo the revocation, so leave that decision to the user.
          if (err instanceof ApiRequestError && err.status === 401) {
            throw new Error(revokedMessage(tray.deviceName));
          }
          throw err;
        }
        debugLog("boot: worker reachable", { device: tray.deviceId });

        const ensured = await trayKeypair(tray);
        tray = ensured.tray;
        await registerDeviceKey(api, ensured.keypair.publicKey);
        try {
          ({ tray, ring } = await refreshTrayRing(api, tray, ensured.keypair, ring));
        } catch (err) {
          if (err instanceof NoSealedKeyError) throw new Error(strandedMessage());
          throw err;
        }

        setBoot({
          state: "ready",
          api,
          ring,
          kdfSalt: config.kdfSalt,
          account: config.userId,
          keypair: ensured.keypair,
          tray,
        });
        debugLog("boot: ready");
      } catch (err) {
        debugLog("boot: failed", describe(err), String(err));
        setBoot({ state: "error", message: describe(err) });
      }
    })();
  }, []);

  // Escape puts the panel away, which is what a dropdown should do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (boot.state === "loading") {
    return <div className="panel centered muted">Loading…</div>;
  }
  if (boot.state === "error") {
    return (
      <div className="panel centered">
        <p className="error">{boot.message}</p>
        <p className="muted small">Details in {"~/.local/state/clipsync/desktop.log"}</p>
      </div>
    );
  }
  return <Keyed boot={boot} onStranded={() => setBoot({ state: "error", message: strandedMessage() })} />;
}

/** Holds the ring, and moves it on when the vault is re-keyed. */
function Keyed({
  boot,
  onStranded,
}: {
  boot: Extract<Boot, { state: "ready" }>;
  onStranded: () => void;
}) {
  const [ring, setRing] = useState(boot.ring);
  const [keys, setKeys] = useState<RingKeys | null>(null);
  const held = useRef({ ring: boot.ring, tray: boot.tray });
  const refreshing = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let live = true;
    void ringKeysFrom(ring, boot.kdfSalt).then((next) => live && setKeys(next));
    return () => {
      live = false;
    };
  }, [ring, boot.kdfSalt]);

  const refresh = useCallback((): Promise<void> => {
    refreshing.current ??= (async () => {
      try {
        const next = await refreshTrayRing(boot.api, held.current.tray, boot.keypair, held.current.ring);
        if (next.ring !== held.current.ring) {
          held.current = next;
          setRing(next.ring);
          debugLog("panel: vault re-keyed", { epoch: next.ring.current });
        }
      } catch (err) {
        if (err instanceof NoSealedKeyError) onStranded();
        else debugLog("panel: key refresh failed", describe(err));
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [boot, onStranded]);

  if (!keys) return <div className="panel centered muted">Loading…</div>;
  return (
    <Panel
      api={boot.api}
      keys={keys}
      account={boot.account}
      tray={boot.tray}
      onRefreshRing={refresh}
    />
  );
}

function Panel({
  api,
  keys,
  account,
  tray,
  onRefreshRing,
}: {
  api: ApiClient;
  keys: RingKeys;
  account: string;
  tray: TrayConfig;
  onRefreshRing: () => Promise<void>;
}) {
  const { clips, loading, error, applyEvent, remove, togglePin, reload } =
    useClips(api, keys, account);
  const onEvent = useCallback(
    (event: SyncEvent) => {
      if (event.type === "vault.rotated") {
        void onRefreshRing();
        return;
      }
      if (
        (event.type === "clip.created" || event.type === "clip.bumped") &&
        event.clip.keyEpoch > keys.current
      ) {
        void onRefreshRing();
      }
      applyEvent(event);
    },
    [applyEvent, keys, onRefreshRing],
  );
  const { status } = useSync(api, onEvent);

  // Live events keep the list current while the socket is up. Refetch on
  // open and on reconnect as well, to cover whatever arrived while the
  // machine slept or the socket was down.
  //
  // Each open also starts a fresh pick: search focused and selected, so
  // typing replaces the last query, and the newest clip highlighted.
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      void reload();
      setSelected(0);
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    unlisten.catch((err) => debugLog("panel: focus listen failed", describe(err)));
    return () => void unlisten.then((fn) => fn());
  }, [reload]);

  useEffect(() => {
    if (status === "online") void reload();
  }, [status, reload]);
  const [query, setQuery] = useState("");
  useEffect(() => setSelected(0), [query]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clips;
    return clips.filter((c) => c.text?.toLowerCase().includes(needle));
  }, [clips, query]);

  const copy = useCallback(async (clip: DecryptedClip) => {
    if (clip.text === null) return;
    try {
      await writeText(clip.text);
      await getCurrentWindow().hide();
    } catch (err) {
      debugLog("copy failed", describe(err));
    }
  }, []);

  // Keep the highlighted clip on screen as the arrows move it.
  useEffect(() => {
    document
      .querySelector(".clip.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, visible]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => Math.max(0, Math.min(visible.length - 1, i + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const clip = visible[selected];
      if (clip) void copy(clip);
    }
  };

  return (
    <div className="panel">
      <header data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>
          ClipSync
        </span>
        <span className={`dot ${status}`} title={status} />
        <button
          className="icon"
          onClick={() => void getCurrentWindow().hide()}
          title="Hide (Esc)"
        >
          ×
        </button>
      </header>

      {status === "revoked" && (
        <p className="error">{revokedMessage(tray.deviceName)}</p>
      )}

      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKey}
        ref={searchRef}
        placeholder="Search…"
        autoFocus
      />

      {error && <p className="error">{error}</p>}
      {loading && <p className="muted pad">Loading…</p>}
      {!loading && !visible.length && (
        <p className="muted pad">
          {query ? "Nothing matches." : "Nothing copied yet."}
        </p>
      )}

      <ul className="clips">
        {visible.map((clip, i) => (
          <li
            key={clip.id}
            className={[
              "clip",
              clip.pinned && "pinned",
              i === selected && "selected",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              className={expanded.has(clip.id) ? "body expanded" : "body"}
              onClick={() => void copy(clip)}
              disabled={clip.text === null}
              title={clip.text ?? undefined}
            >
              {clip.text ?? "Cannot decrypt on this device"}
            </button>
            <div className="actions">
              {isLong(clip.text) && (
                <button onClick={() => toggleExpanded(clip.id)}>
                  {expanded.has(clip.id) ? "less" : "more"}
                </button>
              )}
              <button onClick={() => void togglePin(clip.id, !clip.pinned)}>
                {clip.pinned ? "unpin" : "pin"}
              </button>
              <button onClick={() => void remove(clip.id)}>delete</button>
            </div>
          </li>
        ))}
      </ul>

      <footer>
        <span title={`build ${__CLIPSYNC_BUILD__}`}>{tray.deviceName}</span>
        <span>↑↓ select · Enter copy · Esc hide</span>
      </footer>
    </div>
  );
}
