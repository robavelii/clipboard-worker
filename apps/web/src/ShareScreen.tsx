/**
 * Target for Android's share sheet and for the iOS Shortcut.
 *
 * Both arrive at /share with the text in the URL, because an iOS Shortcut
 * cannot do AES-GCM and so cannot talk to the API directly. It hands the text
 * to this page, which encrypts it properly before anything leaves the device.
 *
 * The URL is the one place the text is plaintext, so it must not reach the
 * server either:
 *   - Android sends `?text=`; the service worker answers that navigation
 *     without forwarding the query (see public/sw.js).
 *   - The iOS Shortcut should open `/share#text=<text>`. A fragment is never
 *     sent by the browser at all, service worker or not.
 * Either way the text is scrubbed from the address bar once read, so it does
 * not linger in browser history.
 *
 * This is also the only way a phone can *send* a clip: no browser may read the
 * clipboard in the background on either platform, so capture has to be an
 * explicit share rather than something automatic.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { NoSealedKeyError } from "@clipsync/client/rekey";
import { ringKeysFrom, sealText, type VaultRing } from "@clipsync/client/ring";
import { STALE_EPOCH_ERROR, type Credentials } from "@clipsync/protocol";
import { cachedRing, syncRing, unlockWithPassphrase } from "./session";

/**
 * Android may send text, a url, or both, in the query; an iOS Shortcut sends
 * text in the fragment.
 */
export function readSharedText(): string | null {
  if (window.location.pathname !== "/share") return null;
  const q = new URLSearchParams(window.location.search);
  const f = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const get = (key: string) => q.get(key) ?? f.get(key);
  const parts = [get("title"), get("text"), get("url")]
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
    async (ring: VaultRing) => {
      setState({ phase: "saving" });
      const api = new ApiClient("", credentials.token);
      const send = async (ring: VaultRing) => {
        const keys = await ringKeysFrom(ring, credentials.kdfSalt);
        await api.createClip(
          await sealText(keys, credentials.userId, credentials.deviceId, text),
        );
      };
      try {
        try {
          await send(ring);
        } catch (err) {
          // Re-keyed since this device last looked: fetch its copy, once.
          if (!(err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR)) throw err;
          await send(await syncRing(api, credentials.deviceId, ring));
        }
        setState({ phase: "saved" });
      } catch (err) {
        if (err instanceof NoSealedKeyError) {
          // Left out of a re-key: the passphrase still unwraps the new key.
          setState({ phase: "locked" });
          return;
        }
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [credentials, text],
  );

  // The text is held in state from here on; keep it out of browser history.
  useEffect(() => {
    window.history.replaceState(null, "", "/share");
  }, []);

  useEffect(() => {
    const ring = cachedRing();
    if (ring) void save(ring);
    else setState({ phase: "locked" });
  }, [save]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setState({ phase: "saving" });
    try {
      const ring = await unlockWithPassphrase(
        new ApiClient("", credentials.token),
        passphrase,
        credentials.kdfSalt,
        credentials.wrappedVaultKey,
        true, // sharing opens a new tab each time; stay unlocked or it is unusable
      );
      await save(ring);
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
