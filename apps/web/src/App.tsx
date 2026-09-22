import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "@clipsync/client";
import type { Device } from "@clipsync/protocol";
import type { VaultKeys } from "@clipsync/crypto";
import {
  cachedVaultKey,
  clearSession,
  forgetVaultKey,
  keysFor,
  loadCredentials,
} from "./session";
import { PairScreen, UnlockScreen } from "./screens";
import { LinkApproval, readLinkFromLocation } from "./LinkApproval";
import { JoinScreen, readInviteFromLocation } from "./JoinScreen";
import { useClips, type DecryptedClip } from "./useClips";
import { useSync } from "./useSync";

export function App() {
  const [creds, setCreds] = useState(loadCredentials);
  const [keys, setKeys] = useState<VaultKeys | null>(null);
  const [link, setLink] = useState(readLinkFromLocation);
  const [invite, setInvite] = useState(readInviteFromLocation);

  const closeLink = useCallback(() => {
    window.history.replaceState(null, "", "/");
    setLink(null);
  }, []);

  // Restore from the tab's cached vault key on reload. No PBKDF2 needed --
  // the expensive step only happens at unlock.
  useEffect(() => {
    const vaultKey = cachedVaultKey();
    if (!creds || !vaultKey || keys) return;
    void keysFor(vaultKey, creds.kdfSalt)
      .then(setKeys)
      .catch(() => forgetVaultKey());
  }, [creds, keys]);

  // A scanned invite outranks everything: it is how an unenrolled device
  // becomes enrolled, and it re-enrols one that was already paired.
  if (invite) {
    return (
      <Centered>
        <JoinScreen
          inviteId={invite.inviteId}
          secret={invite.secret}
          onJoined={() => {
            setInvite(null);
            setCreds(loadCredentials());
          }}
        />
      </Centered>
    );
  }

  if (!creds) return <Centered><PairScreen onPaired={() => setCreds(loadCredentials())} /></Centered>;

  // An approval seals the vault key, so it waits behind the unlock screen
  // like everything else.
  if (link && keys) {
    const vaultKey = cachedVaultKey();
    if (vaultKey) {
      return (
        <Centered>
          <LinkApproval
            linkId={link.linkId}
            publicKey={link.publicKey}
            token={creds.token}
            vaultKey={vaultKey}
            onClose={closeLink}
          />
        </Centered>
      );
    }
  }

  if (!keys) {
    return (
      <Centered>
        <UnlockScreen
          credentials={creds}
          onUnlocked={(vaultKey) =>
            void keysFor(vaultKey, creds.kdfSalt).then(setKeys)
          }
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
        forgetVaultKey();
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
  const [linkUrl, setLinkUrl] = useState("");

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

      {pairCode !== null && (
        <div className="paircode">
          <p>
            Paste a link from <code>clipsync link</code> — the other device
            never has to be told the passphrase:
          </p>
          <form
            className="linkform"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const url = new URL(linkUrl.trim());
                window.location.href = `/link${url.hash}`;
              } catch {
                /* ignore malformed input; the field stays put */
              }
            }}
          >
            <input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://clip.rfh.et/link#…"
            />
            <button type="submit">Open</button>
          </form>
          <p className="muted small">
            Or use a manual pairing code (that device will ask for the
            passphrase): <code>{pairCode}</code> — 10 minutes, single use.
          </p>
          <button className="link" onClick={() => setPairCode(null)}>
            dismiss
          </button>
        </div>
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
