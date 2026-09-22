/** Pre-session screens: pairing this browser, and unlocking the vault. */

import { useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import { deriveKeys, decryptText } from "@clipsync/crypto";
import { cachePassphrase, saveCredentials } from "./session";

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

      // Warn immediately on a passphrase mismatch rather than showing a
      // history of undecryptable rows.
      const keys = await deriveKeys(passphrase, creds.kdfSalt);
      const { clips } = await new ApiClient("", creds.token).listClips(1);
      const sample = clips[0];
      if (sample) {
        try {
          await decryptText(keys, sample.envelope);
        } catch {
          setWarning(
            "That passphrase does not decrypt your existing clips. " +
              "Continuing will show them as locked.",
          );
          setBusy(false);
          return;
        }
      }

      saveCredentials(creds);
      cachePassphrase(passphrase);
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
  kdfSalt,
  onUnlocked,
  onForget,
}: {
  kdfSalt: string;
  onUnlocked: (passphrase: string) => void;
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
      // Derivation is deliberately slow; doing it here surfaces the cost once.
      await deriveKeys(passphrase, kdfSalt);
      cachePassphrase(passphrase);
      onUnlocked(passphrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        {busy ? "Deriving key…" : "Unlock"}
      </button>
      <button type="button" className="link" onClick={onForget}>
        Unpair this browser
      </button>
    </form>
  );
}
