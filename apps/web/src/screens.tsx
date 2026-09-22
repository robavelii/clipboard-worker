/** Pre-session screens: pairing this browser, and unlocking the vault. */

import { useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import type { Credentials } from "@clipsync/protocol";
import { saveCredentials, unlockWithPassphrase } from "./session";

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
        setWarning("That passphrase does not unlock this account.");
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
        Run <code>clipsync pair-code</code> on a device that is already set up.
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
  onUnlocked: (vaultKey: string) => void;
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
      const vaultKey = await unlockWithPassphrase(
        new ApiClient("", credentials.token),
        passphrase,
        credentials.kdfSalt,
        credentials.wrappedVaultKey,
      );
      onUnlocked(vaultKey);
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
