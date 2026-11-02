import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiClient } from "@clipsync/client";
import { deleteAccountWithPassphrase, setAccountEmail } from "@clipsync/client/account";
import { rekeyVault } from "@clipsync/client/rekey";
import { currentKey, readClip, ringKeysFrom, type VaultRing } from "@clipsync/client/ring";
import { changePassphrase } from "@clipsync/client/vault";
import { DecryptError } from "@clipsync/crypto";
import type { BlobUsageResponse, Credentials, Device, WhoAmI } from "@clipsync/protocol";
import { RecoveryPanel } from "./Recovery";
import { cacheRing, isPersisted } from "./session";
import { ago, bytes } from "./time";

export type Section = "devices" | "security" | "account" | "plan";
export const SECTIONS: [Section, string][] = [
  ["devices", "Devices"],
  ["security", "Security"],
  ["account", "Account"],
  ["plan", "Plan & usage"],
];

export function sectionFromPath(path: string): Section | null {
  const m = /^\/settings(?:\/(devices|security|account|plan))?\/?$/.exec(path);
  if (!m) return null;
  return (m[1] as Section | undefined) ?? "devices";
}

function message(err: unknown): string {
  if (err instanceof DecryptError) return "That is not this account's passphrase.";
  return err instanceof Error ? err.message : String(err);
}

const PLATFORM: Record<string, string> = {
  linux: "Linux",
  darwin: "macOS",
  macos: "macOS",
  windows: "Windows",
  win32: "Windows",
  web: "Browser",
  ios: "iPhone",
  android: "Android",
};

interface Props {
  api: ApiClient;
  creds: Credentials;
  ring: VaultRing;
  section: Section;
  onSection: (section: Section) => void;
  onBack: () => void;
  /** A re-key moved this tab to a new ring. */
  onRing: (ring: VaultRing) => void;
  onSignOut: () => void;
  /** The account is gone: forget everything. */
  onDeleted: () => void;
}

export function Settings(props: Props) {
  const { section, onSection, onBack } = props;
  // Set by a revoke, so the Security section opens on the re-key it suggests.
  const [rekeyFor, setRekeyFor] = useState<string | null>(null);
  return (
    <div className="app settings-page">
      <header className="topbar">
        <button className="back" onClick={onBack}>
          ← Clipboard
        </button>
        <h1>Settings</h1>
      </header>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} className={id === section ? "on" : undefined} aria-current={id === section ? "page" : undefined} onClick={() => onSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {section === "devices" && (
            <DevicesSection
              {...props}
              onRekey={(name) => {
                setRekeyFor(name);
                onSection("security");
              }}
            />
          )}
          {section === "security" && <SecuritySection {...props} rekeyFor={rekeyFor} />}
          {section === "account" && <AccountSection {...props} />}
          {section === "plan" && <PlanSection api={props.api} />}
        </div>
      </div>
    </div>
  );
}

function Group({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="group">
      <h2>{title}</h2>
      {intro && <p className="muted">{intro}</p>}
      {children}
    </section>
  );
}

/** One passphrase field, the same everywhere it is asked for. */
function Passphrase({
  id,
  label,
  value,
  onChange,
  autoComplete = "current-password",
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <label htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        required
      />
    </label>
  );
}

/* ---------- Devices ---------- */

function DevicesSection({ api, creds, onSignOut, onRekey }: Props & { onRekey: (name: string) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoked, setRevoked] = useState<string | null>(null);

  const load = useCallback(() => {
    api.devices().then(
      (r) => setDevices(r.devices),
      (err: unknown) => setError(message(err)),
    );
  }, [api]);
  useEffect(load, [load]);

  async function revoke(device: Device) {
    setBusy(true);
    setError(null);
    try {
      await api.revokeDevice(device.id);
      setRevoked(device.name);
      setConfirming(null);
      load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const sorted = devices
    ? [...devices].sort((a, b) =>
        a.id === creds.deviceId ? -1 : b.id === creds.deviceId ? 1 : (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
      )
    : [];

  return (
    <Group
      title="Devices"
      intro="Every device here can read your clipboard. Revoke one you no longer use, or have lost."
    >
      {revoked && (
        <div className="callout">
          <p>
            <strong>{revoked}</strong> is signed out and gets nothing new. It keeps the key to everything copied up to
            now, though. If it was lost or stolen, re-key: every clip moves to a key it never had.
          </p>
          <div className="row">
            <button className="primary" onClick={() => onRekey(revoked)}>
              Re-key now
            </button>
            <button className="link" onClick={() => setRevoked(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {!devices && !error && <p className="muted">Loading…</p>}
      <ul className="list">
        {sorted.map((device) => {
          const self = device.id === creds.deviceId;
          return (
            <li key={device.id} className="item">
              <span className={`dot ${self || device.online ? "on" : ""}`} aria-hidden="true" />
              <div className="grow">
                <strong>
                  {device.name} {self && <span className="tag">This browser</span>}
                </strong>
                <small>
                  {PLATFORM[device.platform] ?? device.platform} ·{" "}
                  {self || device.online ? "online now" : device.lastSeen ? `seen ${ago(device.lastSeen)}` : "never seen"}
                  {" · added "}
                  {new Date(device.createdAt).toLocaleDateString()}
                </small>
              </div>
              {self ? (
                <button onClick={onSignOut}>Sign out</button>
              ) : confirming === device.id ? (
                <div className="row">
                  <button className="danger solid" disabled={busy} onClick={() => void revoke(device)}>
                    {busy ? "Revoking…" : "Revoke"}
                  </button>
                  <button className="link" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="danger" onClick={() => setConfirming(device.id)}>
                  Revoke
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

/* ---------- Security ---------- */

function SecuritySection({ api, creds, ring, onRing, rekeyFor }: Props & { rekeyFor: string | null }) {
  return (
    <>
      <ChangePassphrase api={api} kdfSalt={creds.kdfSalt} />
      <Group title="Recovery key">
        <RecoveryPanel api={api} account={creds.userId} kdfSalt={creds.kdfSalt} vaultKey={currentKey(ring)} embedded />
      </Group>
      <KeepUnlocked ring={ring} />
      <Rekey api={api} creds={creds} ring={ring} onRing={onRing} open={rekeyFor !== null} reason={rekeyFor} />
    </>
  );
}

function ChangePassphrase({ api, kdfSalt }: { api: ApiClient; kdfSalt: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setError("The new passphrase needs at least 8 characters.");
    if (next !== confirm) return setError("The new passphrases don't match.");
    setBusy(true);
    setError(null);
    try {
      await changePassphrase(api, kdfSalt, current, next);
      setDone(true);
      setOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof DecryptError ? "That is not the current passphrase. Nothing was changed." : message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group title="Passphrase" intro="Unlocks your history on a new device. Changing it re-encrypts nothing; your other devices keep working.">
      {done && <p className="ok">Passphrase changed. Use the new one from now on.</p>}
      {!open ? (
        <div className="row">
          <button onClick={() => (setOpen(true), setDone(false))}>Change passphrase</button>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <Passphrase id="pp-current" label="Current passphrase" value={current} onChange={setCurrent} autoFocus />
          <Passphrase id="pp-new" label="New passphrase" value={next} onChange={setNext} autoComplete="new-password" />
          <Passphrase id="pp-confirm" label="New passphrase, again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Changing…" : "Change it"}
            </button>
            <button type="button" className="link" onClick={() => (setOpen(false), setError(null))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Group>
  );
}

function KeepUnlocked({ ring }: { ring: VaultRing }) {
  const [persisted, setPersisted] = useState(isPersisted);
  return (
    <Group
      title="This browser"
      intro="Normally closing the tab locks ClipSync again. Keeping it unlocked makes the share sheet work without the passphrase, but anyone who can open this browser can read your clipboard."
    >
      <label className="checkbox" htmlFor="keep-unlocked">
        <input
          id="keep-unlocked"
          type="checkbox"
          checked={persisted}
          onChange={(e) => {
            cacheRing(ring, e.target.checked);
            setPersisted(e.target.checked);
          }}
        />
        <span>Stay unlocked after the tab closes</span>
      </label>
    </Group>
  );
}

function Rekey({
  api,
  creds,
  ring,
  onRing,
  open: openAtFirst,
  reason,
}: {
  api: ApiClient;
  creds: Credentials;
  ring: VaultRing;
  onRing: (ring: VaultRing) => void;
  open: boolean;
  reason: string | null;
}) {
  const [open, setOpen] = useState(openAtFirst);
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState<"idle" | "rotating" | "moving">("idle");
  const [moved, setMoved] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ reencrypted: number; unreadable: number; unsealed: string[] } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPhase("rotating");
    setError(null);
    try {
      const done = await rekeyVault(
        api,
        { account: creds.userId, kdfSalt: creds.kdfSalt, ring },
        passphrase,
        {
          onRotated: (next) => {
            cacheRing(next);
            onRing(next);
            setPhase("moving");
          },
          onProgress: setMoved,
        },
      );
      setResult({ reencrypted: done.reencrypted, unreadable: done.unreadable, unsealed: done.unsealed.map((d) => d.name) });
      setOpen(false);
      setPassphrase("");
    } catch (err) {
      setError(message(err));
    } finally {
      setPhase("idle");
    }
  }

  return (
    <Group
      title="Re-key the vault"
      intro="Moves every clip to a new key. Your devices get it automatically; revoked ones don't, so the key they kept opens nothing. Do this after revoking a lost device."
    >
      {result && (
        <div className="ok">
          <p>
            Re-keyed. {result.reencrypted} clip{result.reencrypted === 1 ? "" : "s"} moved to the new key.
            {result.unreadable > 0 && ` ${result.unreadable} could not be opened here and stay under the old key.`}
          </p>
          {result.unsealed.length > 0 && (
            <p>
              These devices had no device key and must be enrolled again: {result.unsealed.join(", ")}.
            </p>
          )}
        </div>
      )}
      {!open ? (
        <div className="row">
          <button onClick={() => (setOpen(true), setResult(null))}>Re-key…</button>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          {reason && <p className="muted">After revoking {reason}.</p>}
          <Passphrase id="rekey-pp" label="Passphrase" value={passphrase} onChange={setPassphrase} autoFocus />
          {error && <p className="error">{error}</p>}
          {phase === "moving" && <p className="muted">New key in place. Moving history… {moved} so far. Keep this tab open; if it is interrupted, <code>clipsync rekey --finish</code> resumes it.</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={phase !== "idle"}>
              {phase === "idle" ? "Re-key now" : phase === "rotating" ? "Rotating…" : "Moving history…"}
            </button>
            {phase === "idle" && (
              <button type="button" className="link" onClick={() => (setOpen(false), setError(null))}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </Group>
  );
}

/* ---------- Account ---------- */

function AccountSection({ api, creds, ring, onDeleted }: Props) {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const load = useCallback(() => {
    api.me().then(setMe, () => undefined);
  }, [api]);
  useEffect(load, [load]);
  return (
    <>
      <EmailGroup api={api} kdfSalt={creds.kdfSalt} email={me?.email ?? null} loaded={me !== null} onChanged={load} />
      <ExportGroup api={api} creds={creds} ring={ring} />
      <DeleteGroup api={api} kdfSalt={creds.kdfSalt} hasEmail={Boolean(me?.email)} onDeleted={onDeleted} />
    </>
  );
}

function EmailGroup({
  api,
  kdfSalt,
  email,
  loaded,
  onChanged,
}: {
  api: ApiClient;
  kdfSalt: string;
  email: string | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<"idle" | "address" | "code">("idle");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestEmailCode(address.trim());
      setStep("code");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setAccountEmail(api, { email: address.trim(), code: code.trim(), passphrase, kdfSalt });
      setStep("idle");
      setCode("");
      setPassphrase("");
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const cancel = () => (setStep("idle"), setError(null));

  return (
    <Group title="Email" intro="Where sign-in, recovery and deletion notices go. It is the only thing about you the server can read.">
      {step === "idle" && (
        <div className="item">
          <div className="grow">
            <strong>{loaded ? (email ?? "No address") : "…"}</strong>
            {!email && loaded && <small>Without one, signing in from a new browser and confirming by email can't work.</small>}
          </div>
          <button onClick={() => setStep("address")}>{email ? "Change" : "Add"}</button>
        </div>
      )}
      {step === "address" && (
        <form className="form" onSubmit={(e) => void send(e)}>
          <label htmlFor="email-new">
            <span>New address</span>
            <input id="email-new" type="email" autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} autoFocus required />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Sending…" : "Send a code"}
            </button>
            <button type="button" className="link" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step === "code" && (
        <form className="form" onSubmit={(e) => void save(e)}>
          <p className="muted">We sent a six-digit code to {address}.</p>
          <label htmlFor="email-code">
            <span>Code</span>
            <input id="email-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          </label>
          <Passphrase id="email-pp" label="Passphrase" value={passphrase} onChange={setPassphrase} />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save address"}
            </button>
            <button type="button" className="link" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Group>
  );
}

function ExportGroup({ api, creds, ring }: { api: ApiClient; creds: Credentials; ring: VaultRing }) {
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setCount(0);
    try {
      const keys = await ringKeysFrom(ring, creds.kdfSalt);
      const out: unknown[] = [];
      let before: string | number | undefined;
      do {
        const page = await api.listClips(200, before);
        for (const clip of page.clips) {
          try {
            const opened = await readClip(keys, clip, creds.userId);
            out.push({
              id: clip.id,
              type: clip.type,
              createdAt: new Date(clip.createdAt).toISOString(),
              device: clip.deviceId,
              pinned: clip.pinned,
              ...(clip.type === "text" ? { text: opened.text } : { file: opened.file && { name: opened.file.name, mime: opened.file.mime, size: opened.file.size } }),
            });
          } catch {
            out.push({ id: clip.id, type: clip.type, createdAt: new Date(clip.createdAt).toISOString(), unreadable: true });
          }
        }
        setCount(out.length);
        before = page.nextCursor ?? undefined;
      } while (before !== undefined);
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), clips: out }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clipsync-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group
      title="Export"
      intro={
        <>
          Your history, decrypted here in the browser, as one JSON file. Images and files are listed by name; for their
          contents use <code>clipsync export &lt;dir&gt;</code>.
        </>
      }
    >
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button onClick={() => void run()} disabled={busy}>
          {busy ? `Decrypting… ${count}` : "Download history"}
        </button>
      </div>
    </Group>
  );
}

function DeleteGroup({
  api,
  kdfSalt,
  hasEmail,
  onDeleted,
}: {
  api: ApiClient;
  kdfSalt: string;
  hasEmail: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [by, setBy] = useState<"passphrase" | "email">("passphrase");
  const [secret, setSecret] = useState("");
  const [typed, setTyped] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api.requestDeletionCode();
      setCodeSent(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (by === "passphrase") await deleteAccountWithPassphrase(api, secret, kdfSalt);
      else await api.deleteAccount({ emailCode: secret.trim() });
      onDeleted();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Group title="Delete account" intro="Removes every clip, file and device, for good. Nobody can undo it, including us.">
      {!open ? (
        <div className="row">
          <button className="danger" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        </div>
      ) : (
        <form className="form danger-zone" onSubmit={(e) => void submit(e)}>
          {hasEmail && (
            <div className="segmented" role="radiogroup" aria-label="Confirm with">
              <button type="button" role="radio" aria-checked={by === "passphrase"} className={by === "passphrase" ? "on" : undefined} onClick={() => (setBy("passphrase"), setSecret(""))}>
                Passphrase
              </button>
              <button type="button" role="radio" aria-checked={by === "email"} className={by === "email" ? "on" : undefined} onClick={() => (setBy("email"), setSecret(""))}>
                Emailed code
              </button>
            </div>
          )}
          {by === "passphrase" ? (
            <Passphrase id="del-pp" label="Passphrase" value={secret} onChange={setSecret} autoFocus />
          ) : !codeSent ? (
            <div className="row">
              <button type="button" onClick={() => void sendCode()} disabled={busy}>
                {busy ? "Sending…" : "Email me a code"}
              </button>
            </div>
          ) : (
            <label htmlFor="del-code">
              <span>Code from the email</span>
              <input id="del-code" inputMode="numeric" autoComplete="one-time-code" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus required />
            </label>
          )}
          <label htmlFor="del-typed">
            <span>
              Type <strong>delete</strong> to confirm
            </span>
            <input id="del-typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" required />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" className="danger solid" disabled={busy || typed.trim().toLowerCase() !== "delete" || !secret}>
              {busy ? "Deleting…" : "Delete everything"}
            </button>
            <button type="button" className="link" onClick={() => (setOpen(false), setError(null))}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Group>
  );
}

/* ---------- Plan & usage ---------- */

function PlanSection({ api }: { api: ApiClient }) {
  const [usage, setUsage] = useState<BlobUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.blobUsage().then(setUsage, (err: unknown) => setError(message(err)));
  }, [api]);

  const mine = usage?.account;
  const storageCap = mine ? mine.storageBytes ?? usage.storageBudgetBytes : usage?.storageBudgetBytes ?? 0;
  const stored = mine?.storedBytes ?? usage?.storedBytes ?? 0;

  return (
    <Group
      title="Plan & usage"
      intro="Text clips expire after 30 days and images and files after 7, unless pinned. Files beyond your storage push out your oldest unpinned ones."
    >
      {error && <p className="error">{error}</p>}
      {!usage && !error && <p className="muted">Loading…</p>}
      {usage && (
        <dl className="usage">
          <div>
            <dt>Plan</dt>
            <dd className="plan-name">{mine?.plan ?? "default"}</dd>
          </div>
          <Meter label="File storage" value={stored} max={storageCap} format={bytes} />
          {mine?.classABudget != null && <Meter label={`Uploads this month (${usage.month})`} value={mine.classA} max={mine.classABudget} />}
          {mine?.classBBudget != null && <Meter label={`Downloads this month (${usage.month})`} value={mine.classB} max={mine.classBBudget} />}
        </dl>
      )}
    </Group>
  );
}

function Meter({ label, value, max, format = String }: { label: string; value: number; max: number; format?: (n: number) => string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <meter min={0} max={max || 1} value={value} low={(max || 1) * 0.75} high={(max || 1) * 0.9} optimum={0} />
        <span className="muted small">
          {format(value)} of {format(max)}
        </span>
      </dd>
    </div>
  );
}
