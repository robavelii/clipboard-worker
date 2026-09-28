/**
 * The tray panel.
 *
 * Needs no setup of its own: it takes the vault key from the agent's config
 * and enrols itself as a device on first run, so if `clipsync` works on this
 * machine the panel does too. Everything below that is the same client, the
 * same crypto and the same hooks the web UI uses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import type { Platform } from "@clipsync/protocol";
import { vaultKeysFrom, type VaultKeys } from "@clipsync/crypto";
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
  await invoke("save_tray_config", { json: JSON.stringify(tray, null, 2) });
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
  token: string;
  kdfSalt: string;
  deviceName: string;
  vaultKey?: string;
}

type Boot =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; api: ApiClient; keys: VaultKeys; tray: TrayConfig };

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

        if (!config.vaultKey) {
          throw new Error(
            "This machine's agent has no vault key yet. Run `clipsync status` once, then reopen.",
          );
        }

        const tray = await trayConfigFor(config);
        const api = new ApiClient(tray.baseUrl, tray.token, tauriFetch);

        // Prove the network path before rendering a list that would otherwise
        // fail with WebKit's opaque "Load failed".
        try {
          await api.me();
        } catch (err) {
          // Revoked from another device. Enrolling again here would quietly
          // undo the revocation, so leave that decision to the user.
          if (err instanceof ApiRequestError && err.status === 401) {
            throw new Error(
              `The panel's device "${tray.deviceName}" was revoked. To use it again, delete ~/.config/clipsync/tray.json and reopen.`,
            );
          }
          throw err;
        }
        debugLog("boot: worker reachable", { device: tray.deviceId });

        setBoot({
          state: "ready",
          api,
          keys: await vaultKeysFrom(config.vaultKey, config.kdfSalt),
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
        <p className="muted small">Details in {"/tmp/clipsync-desktop.log"}</p>
      </div>
    );
  }
  return <Panel api={boot.api} keys={boot.keys} tray={boot.tray} />;
}

function Panel({
  api,
  keys,
  tray,
}: {
  api: ApiClient;
  keys: VaultKeys;
  tray: TrayConfig;
}) {
  const { clips, loading, error, applyEvent, remove, togglePin, reload } =
    useClips(api, keys);
  const { status } = useSync(api, applyEvent);

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
              {clip.text ?? "Encrypted with a different passphrase"}
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
