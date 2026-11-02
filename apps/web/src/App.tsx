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
import { EnrolScreen, UnlockScreen } from "./screens";
import { LinkApproval, readLinkFromLocation } from "./LinkApproval";
import { JoinScreen, readInviteFromLocation } from "./JoinScreen";
import { ShareScreen } from "./ShareScreen";
import { dropStaleShares, readShareSource } from "./shares";
import { Compose } from "./Compose";
import { LatestCard, latestFromElsewhere } from "./Latest";
import { PhoneSetup } from "./PhoneSetup";
import { Checklist } from "./Checklist";
import { History } from "./History";
import { Settings, sectionFromPath, type Section } from "./Settings";
import { isTouchFirst } from "./clipboard";
import { useClips, useSync } from "@clipsync/react";

export function App() {
  const [creds, setCreds] = useState(loadCredentials);
  const [ring, setRing] = useState<VaultRing | null>(null);
  const [keys, setKeys] = useState<RingKeys | null>(null);
  /** A re-key left this device out: only the passphrase gets it back in. */
  const [stranded, setStranded] = useState(false);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [link, setLink] = useState(readLinkFromLocation);
  const [invite, setInvite] = useState(readInviteFromLocation);
  const [shared, setShared] = useState(() => readShareSource());
  const [setup, setSetup] = useState(() => window.location.pathname === "/phone");
  const [settings, setSettings] = useState<Section | null>(() => sectionFromPath(window.location.pathname));

  // A share carried in the fragment (the iOS Shortcut's form) does not reload
  // the page when it lands on a tab that is already at /share.
  useEffect(() => {
    const onHash = () => {
      const source = readShareSource();
      if (source) setShared(source);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Back from /phone to wherever it was opened from.
  useEffect(() => {
    const onPop = () => {
      setSetup(window.location.pathname === "/phone");
      setSettings(sectionFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Plaintext kept for a share nobody finished sending does not stay forever.
  useEffect(() => {
    void dropStaleShares();
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

  if (setup) {
    return (
      <Centered>
        <PhoneSetup
          onClose={() => {
            // Opened from the app: step back, so history holds no extra entry.
            if ((window.history.state as { setup?: boolean } | null)?.setup) {
              window.history.back();
              return;
            }
            window.history.replaceState(null, "", "/");
            setSetup(false);
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
          key={JSON.stringify(shared)}
          source={shared}
          credentials={creds}
          onDone={() => {
            window.history.replaceState(null, "", "/");
            setShared(null);
          }}
        />
      </Centered>
    );
  }

  if (!creds) return <Centered><EnrolScreen onEnrolled={() => setCreds(loadCredentials())} /></Centered>;

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

  if (!keys || !ring) return null;

  const signOut = () => {
    // Revoke before forgetting: otherwise the device stays listed and
    // keeps being sealed to by every re-key. Offline, it unpairs anyway;
    // another device can revoke what is left.
    void new ApiClient("", creds.token)
      .revokeSelf()
      .catch(() => undefined)
      .finally(() => {
        clearSession();
        window.history.replaceState(null, "", "/");
        setSettings(null);
        setRing(null);
        setCreds(null);
      });
  };
  const openSettings = (section: Section) => {
    const path = `/settings/${section}`;
    if (settings) window.history.replaceState({ settings: true }, "", path);
    else window.history.pushState({ settings: true }, "", path);
    setSettings(section);
  };

  if (settings) {
    return (
      <Settings
        api={new ApiClient("", creds.token)}
        creds={creds}
        ring={ring}
        section={settings}
        onSection={openSettings}
        onBack={() => {
          if ((window.history.state as { settings?: boolean } | null)?.settings) {
            window.history.back();
            return;
          }
          window.history.replaceState(null, "", "/");
          setSettings(null);
        }}
        onRing={setRing}
        onSignOut={signOut}
        onDeleted={() => {
          clearSession();
          window.history.replaceState(null, "", "/");
          setSettings(null);
          setRing(null);
          setCreds(null);
        }}
      />
    );
  }

  return (
    <Workspace
      keys={keys}
      token={creds.token}
      account={creds.userId}
      deviceId={creds.deviceId}
      stranded={stranded}
      onRefreshRing={refreshRing}
      onUnlockAgain={() => setNeedsPassphrase(true)}
      onSetup={() => {
        window.history.pushState({ setup: true }, "", "/phone");
        setSetup(true);
      }}
      onSettings={openSettings}
      onSignOut={signOut}
      onLock={() => {
        forgetVaultKey();
        setRing(null);
      }}
    />
  );
}

type Filter = "all" | "pinned" | "files" | "here";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["pinned", "Pinned"],
  ["files", "Images & files"],
  ["here", "From this browser"],
];

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

function Workspace({
  keys,
  token,
  account,
  deviceId,
  stranded,
  onRefreshRing,
  onUnlockAgain,
  onSetup,
  onSettings,
  onSignOut,
  onLock,
}: {
  keys: RingKeys;
  token: string;
  /** The user id envelopes are bound to. */
  account: string;
  deviceId: string;
  stranded: boolean;
  onRefreshRing: () => Promise<void>;
  onUnlockAgain: () => void;
  onSetup: () => void;
  onSettings: (section: Section) => void;
  onSignOut: () => void;
  onLock: () => void;
}) {
  const api = useMemo(() => new ApiClient("", token), [token]);
  const { clips, loading, error, hasMore, loadMore, applyEvent, remove, togglePin, reload } =
    useClips(api, keys, account);
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
  const [filter, setFilter] = useState<Filter>("all");

  const refreshDevices = useCallback(() => {
    void api.devices().then((r) => setDevices(r.devices)).catch(() => {});
  }, [api]);

  useEffect(refreshDevices, [refreshDevices, connected.length]);

  const deviceNames = useMemo(
    () => new Map(devices.map((d) => [d.id, d.name])),
    [devices],
  );

  // On a phone, the newest copy from elsewhere sits one tap from the clipboard.
  const touchFirst = useMemo(isTouchFirst, []);
  const latest = useMemo(
    () => (touchFirst ? latestFromElsewhere(clips, deviceId) : null),
    [touchFirst, clips, deviceId],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clips.filter(
      (c) =>
        (filter === "all" ||
          (filter === "pinned" && c.pinned) ||
          (filter === "files" && c.type !== "text") ||
          (filter === "here" && c.deviceId === deviceId)) &&
        (!needle || c.text?.toLowerCase().includes(needle)),
    );
  }, [clips, query, filter, deviceId]);

  // The ⋯ menu is a <details>: close it on a click anywhere outside it.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.menu[open]")) {
        if (!menu.contains(e.target as Node)) menu.open = false;
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const online = devices.filter((d) => d.id === deviceId || connected.includes(d.id)).length;
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to search, Escape leaves it, as in most tools with a list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea");
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === "Escape" && e.target === search.current) {
        setQuery("");
        search.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const addDevice = () => void api.pairCode().then((r) => setPairCode(r.code)).catch(() => {});
  const state =
    status === "online"
      ? { cls: "live", text: `${online} of ${devices.length} device${devices.length === 1 ? "" : "s"} online` }
      : status === "connecting"
        ? { cls: "", text: "Connecting" }
        : status === "revoked"
          ? { cls: "bad", text: "Signed out" }
          : { cls: "bad", text: "Offline, retrying" };

  const emptyText = loading
    ? null
    : query || filter !== "all"
      ? hasMore
        ? `Nothing in the ${clips.length} clips loaded so far. Search older ones below.`
        : "Nothing matches."
      : "Nothing copied yet. Copy something on a device running ClipSync, or paste it above.";

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">ClipSync</h1>
        <span className="grow" />
        <button type="button" className={`status ${state.cls}`} onClick={() => onSettings("devices")} title={devices.map((d) => d.name).join(", ")}>
          {state.text}
        </button>
        <button type="button" className="quiet" onClick={addDevice}>
          Add device
        </button>
        <button type="button" className="quiet" onClick={onLock} title="Forget the key in this tab. The passphrase opens it again.">
          Lock
        </button>
        <details className="menu">
          <summary aria-label="Menu">Menu</summary>
          <div className="menu-items" role="menu">
            <button type="button" role="menuitem" onClick={() => onSettings("devices")}>Devices</button>
            <button type="button" role="menuitem" onClick={() => onSettings("security")}>Security and recovery key</button>
            <button type="button" role="menuitem" onClick={() => onSettings("account")}>Account</button>
            <button type="button" role="menuitem" onClick={() => onSettings("plan")}>Plan and usage</button>
            <button type="button" role="menuitem" onClick={onSetup}>Set up a phone</button>
            <button type="button" role="menuitem" className="narrow-only" onClick={addDevice}>Add device</button>
            <button type="button" role="menuitem" className="narrow-only" onClick={onLock}>Lock this tab</button>
            <hr />
            <button type="button" role="menuitem" className="danger" onClick={onSignOut}>
              Sign out of this browser
            </button>
          </div>
        </details>
      </header>

      <Compose
        api={api}
        keys={keys}
        account={account}
        deviceId={deviceId}
        onSent={reload}
        onStale={onRefreshRing}
      />

      {pairCode !== null && (
        <section className="notice" aria-label="Add a device">
          <h2>Add a device</h2>
          <p>
            On the new device, run <code>clipsync link</code> and paste the link it prints here. It never needs the
            passphrase.
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
            <label htmlFor="link-url" className="visually-hidden">
              Link from clipsync link
            </label>
            <input
              id="link-url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="https://clip.rfh.et/link#…"
            />
            <button type="submit">Open</button>
          </form>
          <p className="muted small">
            Or type this pairing code there; that device will then ask for the passphrase. It works once, for 10
            minutes.
          </p>
          <p className="code measured">{pairCode}</p>
          <div className="row">
            <button type="button" className="link" onClick={() => setPairCode(null)}>
              Done
            </button>
          </div>
        </section>
      )}

      {stranded && (
        <section className="notice bad" aria-label="This browser missed a re-key">
          <p>
            Your clipboard was re-keyed, and this browser did not get the new key: it had no device key registered yet.
            New clips will not open here until you enter your passphrase.
          </p>
          <div className="row">
            <button type="button" onClick={onUnlockAgain}>Enter passphrase</button>
          </div>
        </section>
      )}

      <Checklist api={api} devices={devices} onAddDevice={addDevice} onSettings={onSettings} />

      {latest && !query && (
        <LatestCard
          clip={latest}
          api={api}
          keys={keys}
          account={account}
          origin={deviceNames.get(latest.deviceId) ?? "another device"}
        />
      )}

      <div className="historyhead">
        <h2>History</h2>
        <input
          ref={search}
          className="search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${clips.length} loaded clip${clips.length === 1 ? "" : "s"}`}
          aria-label="Search clips"
          aria-keyshortcuts="/"
        />
        <div className="segmented filters" role="tablist" aria-label="Show">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "on" : undefined}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && !clips.length && (
        <ul className="ledger skeleton" aria-hidden="true">
          <li /><li /><li />
        </ul>
      )}

      <History
        clips={visible}
        api={api}
        keys={keys}
        account={account}
        deviceId={deviceId}
        deviceNames={deviceNames}
        onDelete={(id) => void remove(id)}
        onTogglePin={(id, pinned) => void togglePin(id, pinned)}
        emptyText={emptyText}
      />

      {hasMore && (
        <button type="button" className="more" onClick={loadMore}>
          {query || filter !== "all" ? "Search older clips too" : "Load older clips"}
        </button>
      )}

      <p className="keys muted small" aria-hidden="true">
        <kbd>/</kbd> search <kbd>j</kbd> <kbd>k</kbd> move <kbd>c</kbd> copy <kbd>p</kbd> pin <kbd>Del</kbd> delete
      </p>
    </div>
  );
}
