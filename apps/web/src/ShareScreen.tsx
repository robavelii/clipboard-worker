/**
 * Target for Android's share sheet and for the iOS Shortcut.
 *
 * Both arrive the same way -- a GET to /share with the text as a query
 * parameter -- because an iOS Shortcut cannot do AES-GCM and so cannot talk to
 * the API directly. It hands the text to this page, which encrypts it properly
 * before anything leaves the device.
 *
 * This is also the only way a phone can *send* a clip: no browser may read the
 * clipboard in the background on either platform, so capture has to be an
 * explicit share rather than something automatic.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import { dedupeHash, encryptText, vaultKeysFrom } from "@clipsync/crypto";
import type { Credentials } from "@clipsync/protocol";
import { cachedVaultKey, unlockWithPassphrase } from "./session";

/** Android may send text, a url, or both; an iOS Shortcut sends text. */
export function readSharedText(): string | null {
  if (window.location.pathname !== "/share") return null;
  const q = new URLSearchParams(window.location.search);
  const parts = [q.get("title"), q.get("text"), q.get("url")]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));

  // A shared link often arrives as both `text` and `url` with the same value.
  const unique = [...new Set(parts)];
  return unique.length ? unique.join("\n") : null;
}

type State =
  | { phase: "locked" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; message: string };

export function ShareScreen({
  text,
  credentials,
  onDone,
}: {
  text: string;
  credentials: Credentials;
  onDone: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "saving" });
  const [passphrase, setPassphrase] = useState("");

  const save = useCallback(
    async (vaultKey: string) => {
      setState({ phase: "saving" });
      try {
        const api = new ApiClient("", credentials.token);
        const keys = await vaultKeysFrom(vaultKey, credentials.kdfSalt);
        await api.createClip({
          type: "text",
          envelope: await encryptText(keys, text),
          contentHash: await dedupeHash(keys, text),
          size: new TextEncoder().encode(text).length,
        });
        setState({ phase: "saved" });
      } catch (err) {
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [credentials, text],
  );

  useEffect(() => {
    const vaultKey = cachedVaultKey();
    if (vaultKey) void save(vaultKey);
    else setState({ phase: "locked" });
  }, [save]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setState({ phase: "saving" });
    try {
      const vaultKey = await unlockWithPassphrase(
        new ApiClient("", credentials.token),
        passphrase,
        credentials.kdfSalt,
        credentials.wrappedVaultKey,
        true, // sharing opens a new tab each time; stay unlocked or it is unusable
      );
      await save(vaultKey);
    } catch {
      setState({ phase: "error", message: "That passphrase did not unlock this account." });
    }
  }

  const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;

  if (state.phase === "locked") {
    return (
      <form className="card" onSubmit={unlock}>
        <h1>Unlock to save</h1>
        <pre className="sharepreview">{preview}</pre>
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
        <p className="muted small">
          This device will stay unlocked afterwards, so sharing does not ask
          again.
        </p>
        <button type="submit">Unlock and save</button>
      </form>
    );
  }

  return (
    <div className="card">
      <h1>
        {state.phase === "saving"
          ? "Saving…"
          : state.phase === "saved"
            ? "Saved to ClipSync"
            : "Could not save"}
      </h1>

      <pre className="sharepreview">{preview}</pre>

      {state.phase === "error" && <p className="error">{state.message}</p>}
      {state.phase === "saved" && (
        <p className="muted">It is on your other devices already.</p>
      )}

      {state.phase !== "saving" && (
        <button onClick={onDone}>Open ClipSync</button>
      )}
    </div>
  );
}
