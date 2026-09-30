/**
 * Target for the share sheet and for the iOS Shortcut.
 *
 * Text, links, photos and files all arrive here as plaintext, and must not
 * reach the server until this page has encrypted them:
 *   - The share sheet POSTs a form. The service worker answers it without
 *     forwarding it, keeps it in IndexedDB and opens /share?pending=<id>
 *     (public/sw.js, src/shares.ts, decisions §35). The kept copy is
 *     deleted once it is sent.
 *   - The iOS Shortcut cannot do AES-GCM, so it opens `/share#text=<text>`
 *     instead of calling the API. A fragment is never sent by the browser.
 *   - Installs from before files still GET `/share?text=`; the service
 *     worker answers that navigation without forwarding the query.
 * Text in the address bar is scrubbed once read, so it does not linger in
 * browser history.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { NoSealedKeyError } from "@clipsync/client/rekey";
import { ringKeysFrom, type VaultRing } from "@clipsync/client/ring";
import { STALE_EPOCH_ERROR, type Credentials } from "@clipsync/protocol";
import { cachedRing, syncRing, unlockWithPassphrase } from "./session";
import { deletePendingShare, joinShared, loadPendingShare, type ShareSource } from "./shares";
import { sendFile, sendText } from "./clipboard";
import { formatBytes } from "./FileView";

interface Shared {
  text: string | null;
  files: File[];
}

type State =
  | { phase: "loading" }
  | { phase: "locked" }
  | { phase: "saving"; label: string }
  | { phase: "saved" }
  /** The share is not there: already sent, dropped, or never stored. */
  | { phase: "missing"; message: string }
  | { phase: "error"; message: string };

export function ShareScreen({
  source,
  credentials,
  onDone,
}: {
  source: ShareSource;
  credentials: Credentials;
  onDone: () => void;
}) {
  const [shared, setShared] = useState<Shared | null>(null);
  const [state, setState] = useState<State>({ phase: "loading" });
  const [passphrase, setPassphrase] = useState("");
  const pendingId = source.kind === "pending" ? source.id : null;

  // Text in the address bar is plaintext: keep it out of browser history.
  // A pending share's id is not, and a reload while locked needs it.
  useEffect(() => {
    if (source.kind === "text") window.history.replaceState(null, "", "/share");
  }, [source]);

  useEffect(() => {
    let live = true;
    if (source.kind === "failed") {
      setState({
        phase: "missing",
        message:
          "ClipSync could not receive that share, so nothing was sent. Open ClipSync once, then share again.",
      });
    } else if (source.kind === "text") {
      setShared({ text: source.text, files: [] });
    } else {
      loadPendingShare(source.id)
        .then((share) => {
          if (!live) return;
          const text = share && joinShared([share.title, share.text, share.url]);
          if (share && (text || share.files.length)) {
            setShared({ text, files: share.files });
          } else {
            setState({ phase: "missing", message: "That share was already sent, or has expired." });
          }
        })
        .catch(() => {
          if (live) setState({ phase: "missing", message: "This browser could not open that share." });
        });
    }
    return () => {
      live = false;
    };
  }, [source]);

  const save = useCallback(
    async (ring: VaultRing) => {
      if (!shared) return;
      const api = new ApiClient("", credentials.token);
      const { userId: account, deviceId } = credentials;
      const send = async (ring: VaultRing) => {
        const keys = await ringKeysFrom(ring, credentials.kdfSalt);
        if (shared.text) {
          setState({ phase: "saving", label: "Saving…" });
          await sendText(api, keys, account, deviceId, shared.text);
        }
        for (const file of shared.files) {
          setState({ phase: "saving", label: `Uploading ${file.name}…` });
          await sendFile(api, keys, account, deviceId, file, (sent, total) =>
            setState({
              phase: "saving",
              label: `Uploading ${file.name}… ${formatBytes(sent)} of ${formatBytes(total)}`,
            }),
          );
        }
      };
      try {
        try {
          await send(ring);
        } catch (err) {
          // Re-keyed since this device last looked: fetch its copy, once. A
          // part already sent is sent again, which the server dedupes.
          if (!(err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR)) throw err;
          await send(await syncRing(api, credentials.deviceId, ring));
        }
        if (pendingId !== null) await deletePendingShare(pendingId).catch(() => undefined);
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
    [credentials, shared, pendingId],
  );

  useEffect(() => {
    if (!shared) return;
    const ring = cachedRing();
    if (ring) void save(ring);
    else setState({ phase: "locked" });
  }, [shared, save]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setState({ phase: "saving", label: "Unlocking…" });
    let ring: VaultRing;
    try {
      ring = await unlockWithPassphrase(
        new ApiClient("", credentials.token),
        passphrase,
        credentials.kdfSalt,
        credentials.wrappedVaultKey,
        true, // sharing opens a new tab each time; stay unlocked or it is unusable
      );
    } catch {
      setState({ phase: "error", message: "That passphrase did not unlock this account." });
      return;
    }
    await save(ring);
  }

  function discard() {
    const done = pendingId !== null ? deletePendingShare(pendingId) : Promise.resolve();
    void done.catch(() => undefined).finally(onDone);
  }

  const preview = shared && <SharePreview shared={shared} />;

  if (state.phase === "locked") {
    return (
      <form className="card" onSubmit={unlock}>
        <h1>Unlock to save</h1>
        {preview}
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
        {pendingId !== null && (
          <button type="button" className="link" onClick={discard}>
            Discard
          </button>
        )}
      </form>
    );
  }

  const title = {
    loading: "Opening…",
    saving: "Saving…",
    saved: "Saved to ClipSync",
    missing: "Nothing to save",
    error: "Could not save",
  }[state.phase];

  return (
    <div className="card">
      <h1>{title}</h1>
      {preview}

      {state.phase === "saving" && <p className="muted small">{state.label}</p>}
      {(state.phase === "error" || state.phase === "missing") && (
        <p className="error">{state.message}</p>
      )}
      {state.phase === "saved" && (
        <p className="muted">It is on your other devices already.</p>
      )}

      {state.phase === "error" && shared && (
        <div className="row">
          <button
            onClick={() => {
              const ring = cachedRing();
              if (ring) void save(ring);
              else setState({ phase: "locked" });
            }}
          >
            Try again
          </button>
          {pendingId !== null && (
            <button className="link" onClick={discard}>
              Discard
            </button>
          )}
        </div>
      )}

      {state.phase !== "saving" && state.phase !== "loading" && (
        <button onClick={onDone}>Open ClipSync</button>
      )}
    </div>
  );
}

function SharePreview({ shared }: { shared: Shared }) {
  const text = shared.text;
  return (
    <>
      {text && (
        <pre className="sharepreview">{text.length > 300 ? `${text.slice(0, 300)}…` : text}</pre>
      )}
      {shared.files.length > 0 && (
        <ul className="sharefiles">
          {shared.files.map((file, i) => (
            <SharedFile key={i} file={file} />
          ))}
        </ul>
      )}
    </>
  );
}

function SharedFile({ file }: { file: File }) {
  const isImage = file.type.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file, isImage]);
  return (
    <li>
      {url && <img className="preview" src={url} alt="" />}
      <span className="filename">{file.name}</span>
      <span className="muted small">{formatBytes(file.size)}</span>
    </li>
  );
}
