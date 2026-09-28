import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "@clipsync/client";
import { NoSealedKeyError } from "@clipsync/client/rekey";
import {
  currentKey,
  ringKeysFrom,
  type RingKeys,
  type VaultRing,
} from "@clipsync/client/ring";
import type { Device, SyncEvent } from "@clipsync/protocol";
import {
  cachedRing,
  clearSession,
  forgetVaultKey,
  loadCredentials,
  syncRing,
} from "./session";
import { PairScreen, UnlockScreen } from "./screens";
import { LinkApproval, readLinkFromLocation } from "./LinkApproval";
import { JoinScreen, readInviteFromLocation } from "./JoinScreen";
import { ShareScreen, readSharedText } from "./ShareScreen";
import { Compose } from "./Compose";
import { useClips, useSync, type DecryptedClip } from "@clipsync/react";

export function App() {
  const [creds, setCreds] = useState(loadCredentials);
  const [ring, setRing] = useState<VaultRing | null>(null);
  const [keys, setKeys] = useState<RingKeys | null>(null);
  /** A re-key left this device out: only the passphrase gets it back in. */
  const [stranded, setStranded] = useState(false);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [link, setLink] = useState(readLinkFromLocation);
  const [invite, setInvite] = useState(readInviteFromLocation);
  const [shared, setShared] = useState(readSharedText);

  // A share carried in the fragment (the iOS Shortcut's form) does not reload
  // the page when it lands on a tab that is already at /share.
  useEffect(() => {
    const onHash = () => {
      const text = readSharedText();
      if (text) setShared(text);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const closeLink = useCallback(() => {
    window.history.replaceState(null, "", "/");
    setLink(null);
  }, []);

  // Restore from the tab's cached vault keys on reload. No PBKDF2 needed --
  // the expensive step only happens at unlock.
  useEffect(() => {
    if (!creds || ring || needsPassphrase) return;
    const cached = cachedRing();
    if (cached) setRing(cached);
  }, [creds, ring, needsPassphrase]);

  // HKDF only. Not cleared while the next set derives, so picking up a
  // re-key does not flash the unlock screen.
  useEffect(() => {
    if (!creds || !ring) {
      setKeys(null);
      return;
    }
    let live = true;
    ringKeysFrom(ring, creds.kdfSalt)
      .then((next) => live && setKeys(next))
      .catch(() => {
        forgetVaultKey();
        setRing(null);
      });
    return () => {
      live = false;
    };
  }, [creds, ring]);

  // Pick up a re-key: on unlock (it may have happened while this tab was
  // closed), on the vault.rotated event, and on a write refused as stale.
  // Concurrent triggers share one fetch.
  const ringRef = useRef(ring);
  ringRef.current = ring;
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshRing = useCallback((): Promise<void> => {
    const held = ringRef.current;
    if (!creds || !held) return Promise.resolve();
    refreshing.current ??= (async () => {
      try {
        const next = await syncRing(new ApiClient("", creds.token), creds.deviceId, held);
        if (next !== held) setRing(next);
      } catch (err) {
        if (err instanceof NoSealedKeyError) setStranded(true);
        // Anything else: the next trigger tries again.
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [creds]);

  const unlocked = ring !== null;
  useEffect(() => {
    if (unlocked) void refreshRing();
  }, [unlocked, refreshRing]);

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

  // Arriving from a share sheet: save first, browse second.
  if (shared && creds) {
    return (
      <Centered>
        <ShareScreen
          key={shared}
          text={shared}
          credentials={creds}
          onDone={() => {
            window.history.replaceState(null, "", "/");
            setShared(null);
          }}
        />
      </Centered>
    );
  }

  if (!creds) return <Centered><PairScreen onPaired={() => setCreds(loadCredentials())} /></Centered>;

  // An approval seals the vault key, so it waits behind the unlock screen
  // like everything else.
  if (link && ring && !needsPassphrase) {
    return (
      <Centered>
        <LinkApproval
          linkId={link.linkId}
          publicKey={link.publicKey}
          token={creds.token}
          vaultKey={currentKey(ring)}
          onClose={closeLink}
        />
      </Centered>
    );
  }

  if (!ring || needsPassphrase) {
    return (
      <Centered>
        <UnlockScreen
          credentials={creds}
          onUnlocked={(next) => {
            setNeedsPassphrase(false);
            setStranded(false);
            setRing(next);
          }}
          onForget={() => {
            void new ApiClient("", creds.token)
              .revokeSelf()
              .catch(() => undefined)
              .finally(() => {
                clearSession();
                setNeedsPassphrase(false);
                setRing(null);
                setCreds(null);
              });
          }}
        />
      </Centered>
    );
  }

  if (!keys) return null;

  return (
    <Workspace
      keys={keys}
      token={creds.token}
      deviceId={creds.deviceId}
      stranded={stranded}
      onRefreshRing={refreshRing}
      onUnlockAgain={() => setNeedsPassphrase(true)}
      onSignOut={() => {
        // Revoke before forgetting: otherwise the device stays listed and
        // keeps being sealed to by every re-key. Offline, it unpairs anyway;
        // another device can revoke what is left.
        void new ApiClient("", creds.token)
          .revokeSelf()
          .catch(() => undefined)
          .finally(() => {
            clearSession();
            setRing(null);
            setCreds(null);
          });
      }}
      onLock={() => {
        forgetVaultKey();
        setRing(null);
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
  stranded,
  onRefreshRing,
  onUnlockAgain,
  onSignOut,
  onLock,
}: {
  keys: RingKeys;
  token: string;
  deviceId: string;
  stranded: boolean;
  onRefreshRing: () => Promise<void>;
  onUnlockAgain: () => void;
  onSignOut: () => void;
  onLock: () => void;
}) {
  const api = useMemo(() => new ApiClient("", token), [token]);
  const { clips, loading, error, hasMore, loadMore, applyEvent, remove, togglePin, reload } =
    useClips(api, keys);
  const onEvent = useCallback(
    (event: SyncEvent) => {
      if (event.type === "vault.rotated") {
        void onRefreshRing();
        return;
      }
      // Under a key this tab does not hold yet: the rotation event may have
      // been missed. The list reloads once the key is in.
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
  const { status, connected } = useSync(api, onEvent);

  // Nothing is queued for a socket that was down, and a phone suspends a
  // background tab's socket freely: refetch whenever it comes back online
  // and whenever the tab is looked at again, as the tray does on focus.
  useEffect(() => {
    if (status === "online") void reload();
  }, [status, reload]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

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

      {stranded && (
        <div className="notice">
          <p>
            Your vault was re-keyed, and this browser did not get the new key —
            it had no device key registered yet. New clips will not open here
            until you unlock with your passphrase.
          </p>
          <button onClick={onUnlockAgain}>Unlock with passphrase</button>
        </div>
      )}

      <Compose api={api} keys={keys} onSent={reload} onStale={onRefreshRing} />

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
        {clip.text ?? "Cannot decrypt on this device"}
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
