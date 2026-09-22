import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "@clipsync/client";
import type { Device } from "@clipsync/protocol";
import type { VaultKeys } from "@clipsync/crypto";
import {
  cachedPassphrase,
  clearSession,
  forgetPassphrase,
  loadCredentials,
  unlock,
} from "./session";
import { PairScreen, UnlockScreen } from "./screens";
import { useClips, type DecryptedClip } from "./useClips";
import { useSync } from "./useSync";

export function App() {
  const [creds, setCreds] = useState(loadCredentials);
  const [keys, setKeys] = useState<VaultKeys | null>(null);

  // Restore the key from the tab's cached passphrase on reload.
  useEffect(() => {
    const pass = cachedPassphrase();
    if (!creds || !pass || keys) return;
    void unlock(pass, creds.kdfSalt).then(setKeys).catch(() => forgetPassphrase());
  }, [creds, keys]);

  if (!creds) return <Centered><PairScreen onPaired={() => setCreds(loadCredentials())} /></Centered>;

  if (!keys) {
    return (
      <Centered>
        <UnlockScreen
          kdfSalt={creds.kdfSalt}
          onUnlocked={(pass) => void unlock(pass, creds.kdfSalt).then(setKeys)}
          onForget={() => {
            clearSession();
            setCreds(null);
          }}
        />
      </Centered>
    );
  }

  return (
    <Workspace
      keys={keys}
      token={creds.token}
      deviceId={creds.deviceId}
      onSignOut={() => {
        clearSession();
        setKeys(null);
        setCreds(null);
      }}
      onLock={() => {
        forgetPassphrase();
        setKeys(null);
      }}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

function Workspace({
  keys,
  token,
  deviceId,
  onSignOut,
  onLock,
}: {
  keys: VaultKeys;
  token: string;
  deviceId: string;
  onSignOut: () => void;
  onLock: () => void;
}) {
  const api = useMemo(() => new ApiClient("", token), [token]);
  const { clips, loading, error, hasMore, loadMore, applyEvent, remove, togglePin } =
    useClips(api, keys);
  const { status, connected } = useSync(api, applyEvent);

  const [devices, setDevices] = useState<Device[]>([]);
  const [query, setQuery] = useState("");
  const [pairCode, setPairCode] = useState<string | null>(null);

  const refreshDevices = useCallback(() => {
    void api.devices().then((r) => setDevices(r.devices)).catch(() => {});
  }, [api]);

  useEffect(refreshDevices, [refreshDevices, connected.length]);

  const deviceNames = useMemo(
    () => new Map(devices.map((d) => [d.id, d.name])),
    [devices],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clips;
    return clips.filter((c) => c.text?.toLowerCase().includes(needle));
  }, [clips, query]);

  return (
    <div className="app">
      <header>
        <h1>ClipSync</h1>
        <div className="devices">
          {devices.map((device) => (
            <span
              key={device.id}
              className={`device ${connected.includes(device.id) || device.id === deviceId ? "on" : "off"}`}
              title={`${device.platform} · last seen ${device.lastSeen ? new Date(device.lastSeen).toLocaleString() : "never"}`}
            >
              {device.name}
            </span>
          ))}
          <span className={`status ${status}`}>{status}</span>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clipboard…"
        />
        <button
          onClick={() =>
            void api.pairCode().then((r) => setPairCode(r.code)).catch(() => {})
          }
        >
          Add device
        </button>
        <button onClick={onLock}>Lock</button>
        <button className="link" onClick={onSignOut}>
          Unpair
        </button>
      </div>

      {pairCode && (
        <p className="paircode">
          Pairing code <code>{pairCode}</code> — valid 10 minutes, single use.
          <button className="link" onClick={() => setPairCode(null)}>
            dismiss
          </button>
        </p>
      )}

      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && !visible.length && (
        <p className="muted">
          {query ? "Nothing matches." : "No clips yet — copy something."}
        </p>
      )}

      <ul className="clips">
        {visible.map((clip) => (
          <ClipRow
            key={clip.id}
            clip={clip}
            origin={deviceNames.get(clip.deviceId) ?? "unknown device"}
            onDelete={() => void remove(clip.id)}
            onTogglePin={() => void togglePin(clip.id, !clip.pinned)}
          />
        ))}
      </ul>

      {hasMore && !query && (
        <button className="more" onClick={loadMore}>
          Load older clips
        </button>
      )}
    </div>
  );
}

function ClipRow({
  clip,
  origin,
  onDelete,
  onTogglePin,
}: {
  clip: DecryptedClip;
  origin: string;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (clip.text === null) return;
    await navigator.clipboard.writeText(clip.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <li className={clip.pinned ? "clip pinned" : "clip"}>
      <pre className={clip.text === null ? "locked" : undefined}>
        {clip.text ?? "Encrypted with a different passphrase"}
      </pre>
      <div className="meta">
        <span>{origin}</span>
        <span>·</span>
        <time dateTime={new Date(clip.createdAt).toISOString()}>
          {new Date(clip.createdAt).toLocaleString()}
        </time>
        <span className="spacer" />
        <button onClick={onTogglePin} title="Pinned clips never expire">
          {clip.pinned ? "Unpin" : "Pin"}
        </button>
        <button onClick={() => void copy()} disabled={clip.text === null}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}
