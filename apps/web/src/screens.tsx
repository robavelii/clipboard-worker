/** Pre-session screens: enrolling this browser (pair, sign in, sign up), and unlocking the vault. */

import { useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import { requestSignupCode, signIn, signUp, type Enrolled } from "@clipsync/client/account";
import { recoverAccount } from "@clipsync/client/recovery";
import type { Credentials } from "@clipsync/protocol";
import type { VaultRing } from "@clipsync/client/ring";
import { cacheEnrolmentKey, saveCredentials, unlockWithPassphrase } from "./session";

type Way = "pair" | "signin" | "signup" | "recover";

/** How this browser joins: a pairing code, the account's email and passphrase, or a new account. */
export function EnrolScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [way, setWay] = useState<Way>("pair");
  const others: [Way, string][] = (
    [
      ["pair", "Pair with a code"],
      ["signin", "Sign in"],
      ["signup", "Make an account"],
      ["recover", "Forgot the passphrase?"],
    ] as [Way, string][]
  ).filter(([w]) => w !== way);
  return (
    <div className="enrol">
      {way === "pair" && <PairScreen onPaired={onEnrolled} />}
      {way === "signin" && <SignInScreen onEnrolled={onEnrolled} />}
      {way === "signup" && <SignUpScreen onEnrolled={onEnrolled} />}
      {way === "recover" && <RecoverScreen onEnrolled={onEnrolled} />}
      <p className="muted small">
        {others.map(([w, label], i) => (
          <span key={w}>
            {i > 0 && " · "}
            <button type="button" className="link" onClick={() => setWay(w)}>
              {label}
            </button>
          </span>
        ))}
      </p>
    </div>
  );
}

/** Keep what an enrolment returned: the credentials, and the vault key for this tab. */
function keep({ credentials, vaultKey }: Pick<Enrolled, "credentials" | "vaultKey">): void {
  saveCredentials(credentials);
  cacheEnrolmentKey(vaultKey, credentials.keyEpoch);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function SignInScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [email, setEmail] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [name, setName] = useState("Browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      keep(await signIn({ baseUrl: "", email, passphrase, deviceName: name, platform: "web" }));
      onEnrolled();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">
        With no other device at hand: your account's email and passphrase. The passphrase never leaves this
        browser; only a proof of it does.
      </p>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      </label>
      <label>
        Passphrase
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required />
      </label>
      <label>
        Device name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function SignUpScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [email, setEmail] = useState("");
  const [withInvite, setWithInvite] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("Browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestSignupCode("", email);
      setCodeSent(true);
    } catch (err) {
      setError(message(err));
    }
    setBusy(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase !== confirm) {
      setError("The passphrases don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const enrolled = await signUp({
        baseUrl: "",
        email,
        passphrase,
        deviceName: name,
        platform: "web",
        ...(withInvite ? { invite } : { code }),
      });
      keep(enrolled);
      if (enrolled.recoveryKey) setRecoveryKey(enrolled.recoveryKey);
      else onEnrolled();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  if (recoveryKey) return <RecoveryKeyCard recoveryKey={recoveryKey} onDone={onEnrolled} />;

  if (!withInvite && !codeSent) {
    return (
      <form className="card" onSubmit={sendCode}>
        <h1>Make an account</h1>
        <p className="muted">We'll email you a six-digit code to confirm the address.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Email me a code"}
        </button>
        <button type="button" className="link" onClick={() => setWithInvite(true)}>
          I have an invite instead
        </button>
      </form>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Make an account</h1>
      {withInvite ? (
        <>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </label>
          <label>
            Invite
            <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="SIGNUP-…" required />
          </label>
        </>
      ) : (
        <>
          <p className="muted">If {email} can sign up here, a code is on its way to it.</p>
          <label>
            Code from the email
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </label>
        </>
      )}
      <label>
        Encryption passphrase
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required />
      </label>
      <label>
        Passphrase again
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <label>
        Device name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <p className="muted small">
        The passphrase encrypts everything you copy and never leaves your devices. Next you'll get a recovery
        key: the only way back in if you forget it.
      </p>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create the account"}
      </button>
    </form>
  );
}

/**
 * The recovery key, shown the one time it exists anywhere but on paper
 * (decisions §48). Continuing waits for the owner to say it is kept.
 */
function RecoveryKeyCard({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="card">
      <h1>Your recovery key</h1>
      <p className="recovery-key">{recoveryKey}</p>
      <p className="muted">
        Write it down and keep it somewhere safe, away from your devices. It is shown once and stored nowhere. If
        you forget the passphrase, it is the only way back in; whoever holds it can reset the passphrase, so treat
        it like one.
      </p>
      <button
        type="button"
        onClick={() => {
          // Straight from the tap, or iOS refuses the write.
          navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy it"}
      </button>
      <label className="checkbox">
        <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
        <span>I've kept it somewhere safe</span>
      </label>
      <button type="button" className="primary" disabled={!kept} onClick={onDone}>
        Continue
      </button>
    </div>
  );
}

/** Forgot the passphrase: reset it with the recovery key, and enrol this browser. */
function RecoverScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [email, setEmail] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("Browser");
  const [revokeOthers, setRevokeOthers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (passphrase !== confirm) {
      setError("The passphrases don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      keep(
        await recoverAccount({
          baseUrl: "",
          email,
          recoveryKey,
          newPassphrase: passphrase,
          deviceName: name,
          platform: "web",
          revokeOtherDevices: revokeOthers,
        }),
      );
      onEnrolled();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Reset the passphrase</h1>
      <p className="muted">
        With the recovery key you were shown when the account was made. Your clips and your other devices are
        unaffected; only the passphrase changes.
      </p>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      </label>
      <label>
        Recovery key
        <input
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          placeholder="CSR1-…"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        New passphrase
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required />
      </label>
      <label>
        New passphrase again
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <label>
        Device name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={revokeOthers} onChange={(e) => setRevokeOthers(e.target.checked)} />
        <span>Sign every other device out (I lost them)</span>
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Resetting…" : "Reset the passphrase"}
      </button>
    </form>
  );
}

export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("Browser");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);

    try {
      // Same-origin: the Worker serves this page and the API.
      const creds = await new ApiClient("").pair(code, name, "web");
      const api = new ApiClient("", creds.token);

      // A wrong passphrase cannot unwrap the vault key, so it fails here
      // rather than rendering a history of locked rows.
      try {
        await unlockWithPassphrase(
          api,
          passphrase,
          creds.kdfSalt,
          creds.wrappedVaultKey,
        );
      } catch {
        // The code is spent and a device enrolled; revoke it rather than
        // leave a phantom behind. A fresh code is needed either way.
        await api.revokeSelf().catch(() => undefined);
        setWarning(
          "That passphrase does not unlock this account. Mint a new pairing code and try again.",
        );
        setBusy(false);
        return;
      }

      saveCredentials(creds);
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Pair this browser</h1>
      <p className="muted">
        Easier: run <code>clipsync invite</code> on a device that is already set
        up and scan the QR it prints — no passphrase, nothing to type.
      </p>
      <p className="muted small">
        Otherwise, pair with a code from <code>clipsync pair-code</code>:
      </p>

      <label>
        Pairing code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="PAIR-XXXX-XXXX"
          autoFocus
          required
        />
      </label>

      <label>
        Device name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <label>
        Encryption passphrase
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          required
        />
      </label>

      <p className="muted small">
        The passphrase never leaves this browser. It is kept for this tab only.
      </p>

      {error && <p className="error">{error}</p>}
      {warning && <p className="error">{warning}</p>}

      <button type="submit" disabled={busy}>
        {busy ? "Pairing…" : "Pair"}
      </button>
    </form>
  );
}

export function UnlockScreen({
  credentials,
  onUnlocked,
  onForget,
}: {
  credentials: Credentials;
  onUnlocked: (ring: VaultRing) => void;
  onForget: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Deliberately slow: one PBKDF2 to unwrap the vault key, then the key
      // is cached for the tab and nothing else costs anything.
      onUnlocked(
        await unlockWithPassphrase(
          new ApiClient("", credentials.token),
          passphrase,
          credentials.kdfSalt,
          credentials.wrappedVaultKey,
        ),
      );
    } catch {
      setError("That passphrase does not unlock this account.");
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Unlock</h1>
      <p className="muted">
        Your clipboard history is encrypted. Enter your passphrase to read it.
      </p>

      <label>
        Passphrase
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoFocus
          required
        />
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={busy}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      <button type="button" className="link" onClick={onForget}>
        Unpair this browser
      </button>
    </form>
  );
}
