/**
 * The tray panel.
 *
 * Needs no enrolment of its own: it reads the agent's config, which means if
 * `clipsync` works on this machine the panel does too. Everything below that
 * is the same client, the same crypto and the same hooks the web UI uses.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ApiClient } from "@clipsync/client";
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
  | { state: "ready"; api: ApiClient; keys: VaultKeys; config: AgentConfig };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        debugLog("boot: reading agent config");
        const config = JSON.parse(
          await invoke<string>("load_agent_config"),
        ) as AgentConfig;
        debugLog("boot: config ok", { baseUrl: config.baseUrl, device: config.deviceName });

        if (!config.vaultKey) {
          throw new Error(
            "This machine's agent has no vault key yet. Run `clipsync status` once, then reopen.",
          );
        }

        const api = new ApiClient(config.baseUrl, config.token, tauriFetch);

        // Prove the network path before rendering a list that would otherwise
        // fail with WebKit's opaque "Load failed".
        await api.me();
        debugLog("boot: worker reachable");

        setBoot({
          state: "ready",
          api,
          keys: await vaultKeysFrom(config.vaultKey, config.kdfSalt),
          config,
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
  return <Panel api={boot.api} keys={boot.keys} config={boot.config} />;
}

function Panel({
  api,
  keys,
  config,
}: {
  api: ApiClient;
  keys: VaultKeys;
  config: AgentConfig;
}) {
  const { clips, loading, error, applyEvent, remove, togglePin, reload } =
    useClips(api, keys);
  const { status } = useSync(api, applyEvent);

  // The panel signs in as the agent's device, and the Worker never echoes a
  // clip back to the device that sent it. So nothing copied on this machine
  // arrives over the socket: refetch whenever the panel is opened instead,
  // and after a reconnect, which may have missed events from elsewhere.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      debugLog("panel: focus", focused);
      if (focused) void reload();
    });
    unlisten.catch((err) => debugLog("panel: focus listen failed", describe(err)));
    return () => void unlisten.then((fn) => fn());
  }, [reload]);

  useEffect(() => {
    if (status === "online") void reload();
  }, [status, reload]);

  useEffect(() => {
    debugLog("panel:", { status, loading, clips: clips.length, error });
  }, [status, loading, clips.length, error]);
  const [query, setQuery] = useState("");
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
    const matching = needle
      ? clips.filter((c) => c.text?.toLowerCase().includes(needle))
      : clips;
    // Pinned first: the panel is small, so what you chose to keep should not
    // scroll away under whatever you copied a minute ago.
    return [...matching].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt,
    );
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
        {visible.map((clip) => (
          <li key={clip.id} className={clip.pinned ? "clip pinned" : "clip"}>
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

      <footer>{config.deviceName}</footer>
    </div>
  );
}
