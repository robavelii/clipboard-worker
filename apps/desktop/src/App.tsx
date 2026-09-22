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
import { ApiClient } from "@clipsync/client";
import { vaultKeysFrom, type VaultKeys } from "@clipsync/crypto";
import { useClips, useSync, type DecryptedClip } from "@clipsync/react";

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
        const config = JSON.parse(
          await invoke<string>("load_agent_config"),
        ) as AgentConfig;

        if (!config.vaultKey) {
          throw new Error(
            "This machine's agent has no vault key yet. Run `clipsync status` once, then reopen.",
          );
        }

        setBoot({
          state: "ready",
          api: new ApiClient(config.baseUrl, config.token),
          keys: await vaultKeysFrom(config.vaultKey, config.kdfSalt),
          config,
        });
      } catch (err) {
        setBoot({
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
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
  const { clips, loading, error, applyEvent, remove, togglePin } = useClips(
    api,
    keys,
  );
  const { status } = useSync(api, applyEvent);
  const [query, setQuery] = useState("");

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
    await writeText(clip.text);
    await getCurrentWindow().hide();
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
              className="body"
              onClick={() => void copy(clip)}
              disabled={clip.text === null}
              title="Click to copy"
            >
              {clip.text ?? "Encrypted with a different passphrase"}
            </button>
            <div className="actions">
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
