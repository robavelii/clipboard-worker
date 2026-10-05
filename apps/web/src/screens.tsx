/** Pre-session screens: enrolling this browser (pair, sign in, sign up), and unlocking the vault. */

import { useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import { requestSignupCode, signIn, signUp, type Enrolled } from "@clipsync/client/account";
import type { Credentials } from "@clipsync/protocol";
import type { VaultRing } from "@clipsync/client/ring";
import { cacheEnrolmentKey, saveCredentials, unlockWithPassphrase } from "./session";

type Way = "pair" | "signin" | "signup";

/** How this browser joins: a pairing code, the account's email and passphrase, or a new account. */
export function EnrolScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [way, setWay] = useState<Way>("pair");
  const others: [Way, string][] = (
    [
      ["pair", "Pair with a code"],
      ["signin", "Sign in"],
      ["signup", "Make an account"],
    ] as [Way, string][]
  ).filter(([w]) => w !== way);
  return (
    <div className="enrol">
      {way === "pair" && <PairScreen onPaired={onEnrolled} />}
      {way === "signin" && <SignInScreen onEnrolled={onEnrolled} />}
      {way === "signup" && <SignUpScreen onEnrolled={onEnrolled} />}
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
function keep({ credentials, vaultKey }: Enrolled): void {
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
      keep(
        await signUp({
          baseUrl: "",
          email,
          passphrase,
          deviceName: name,
          platform: "web",
          ...(withInvite ? { invite } : { code }),
        }),
      );
      onEnrolled();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

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
        The passphrase encrypts everything you copy and never leaves your devices. Nobody, not the server
        either, can recover your clips without it.
      </p>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create the account"}
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
