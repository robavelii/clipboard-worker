/**
 * Sending from this device: a paste box, and on phones a paste dock.
 *
 * The box is the fallback for everything else: a 2FA code, a field in a
 * password manager, text copied from somewhere that offers no Share action.
 * Open, paste, send. Images and files go the same way: attach one, paste a
 * screenshot, or drop a file on the box. A manual paste into a field prompts
 * for nothing, because the user performing the paste *is* the consent.
 *
 * The dock is one tap instead of three. When ClipSync comes back into view on
 * a phone (after copying something elsewhere, typically), a bar offers
 * "Paste to ClipSync"; the tap reads the clipboard, text or image, and sends
 * it. No browser lets a page read the clipboard except inside a tap, and iOS
 * shows its own Paste bubble for it, so the dock waits to be tapped rather
 * than reading anything by itself.
 */

import { useEffect, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { R2_BUDGET_ERROR, STALE_EPOCH_ERROR } from "@clipsync/protocol";
import { ApiRequestError, type ApiClient } from "@clipsync/client";
import type { RingKeys } from "@clipsync/client/ring";
import { formatBytes } from "./FileView";
import { canReadClipboard, isTouchFirst, readClipboard, sendFile, sendText } from "./clipboard";

export function Compose({
  api,
  keys,
  account,
  deviceId,
  onSent,
  onStale,
}: {
  api: ApiClient;
  keys: RingKeys;
  account: string;
  deviceId: string;
  onSent: () => void;
  /** The vault was re-keyed and this tab missed it: fetch the new key. */
  onStale: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dockable = canReadClipboard() && isTouchFirst();
  const [docked, setDocked] = useState(dockable);

  // Offer the dock again each time the page is looked at.
  useEffect(() => {
    if (!dockable) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") setDocked(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [dockable]);

  async function run(label: string, work: () => Promise<unknown>, onDone?: () => void) {
    setBusy(label);
    setError(null);
    try {
      await work();
      onDone?.();
      setDocked(false);
      setJustSent(true);
      setTimeout(() => setJustSent(false), 1800);
      // The server does not echo an event back to the device that sent it,
      // so refresh rather than wait for a push that will never arrive.
      onSent();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR) {
        // Nothing is lost; once the new key is in, sending works.
        await onStale();
        setError("The vault was re-keyed — send it again.");
      } else if (err instanceof ApiRequestError && err.code === R2_BUDGET_ERROR) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(null);
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const payload = text.trim();
    if (!payload || busy) return;
    void run(
      "Sending…",
      () => sendText(api, keys, account, deviceId, payload),
      () => setText(""),
    );
  }

  function upload(file: File) {
    if (busy) return;
    void run(`Uploading ${file.name}…`, () =>
      sendFile(api, keys, account, deviceId, file, (sent, total) =>
        setBusy(`Uploading ${file.name}… ${formatBytes(sent)} of ${formatBytes(total)}`),
      ),
    );
  }

  function pasteFromClipboard() {
    if (busy) return;
    // No await before the read: it must happen inside the tap.
    const read = readClipboard();
    void run("Reading the clipboard…", async () => {
      let pasted;
      try {
        pasted = await read;
      } catch (err) {
        throw err instanceof DOMException && err.name === "NotAllowedError"
          ? new Error("The browser did not allow reading the clipboard.")
          : err;
      }
      if (!pasted) throw new Error("The clipboard is empty.");
      if ("text" in pasted) {
        setBusy("Sending…");
        await sendText(api, keys, account, deviceId, pasted.text);
      } else {
        setBusy(`Uploading ${pasted.file.name}…`);
        await sendFile(api, keys, account, deviceId, pasted.file, (sent, total) =>
          setBusy(`Uploading ${pasted.file.name}… ${formatBytes(sent)} of ${formatBytes(total)}`),
        );
      }
    });
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // A pasted screenshot arrives as a file; pasted text goes in the box.
    const file = [...event.clipboardData.files][0];
    if (file) {
      event.preventDefault();
      upload(file);
    }
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    const file = [...event.dataTransfer.files][0];
    if (file) {
      event.preventDefault();
      upload(file);
    }
  }

  return (
    <>
      <form
        className="compose"
        onSubmit={send}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          placeholder="Paste here to send to your other devices… or drop a file"
          rows={2}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter keeps a newline, as everywhere else.
            if (e.key === "Enter" && !e.shiftKey) send(e as unknown as FormEvent);
          }}
        />
        <div className="composebar">
          {error ? (
            <span className="error">{error}</span>
          ) : (
            <span className="muted small">
              {busy ?? (justSent ? "Sent to your devices" : "Enter to send")}
            </span>
          )}
          <label className={busy ? "attach disabled" : "attach"}>
            Attach
            <input
              type="file"
              disabled={Boolean(busy)}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) upload(file);
              }}
            />
          </label>
          <button type="submit" disabled={!text.trim() || Boolean(busy)}>
            {busy === "Sending…" ? "Sending…" : "Send"}
          </button>
        </div>
      </form>

      {docked && (
        <div className="dock" role="region" aria-label="Paste to ClipSync">
          {busy || error ? (
            <span className={error ? "error" : "muted small"}>{error ?? busy}</span>
          ) : null}
          <div className="dockbar">
            <button className="primary" onClick={pasteFromClipboard} disabled={Boolean(busy)}>
              Paste to ClipSync
            </button>
            <button className="link" onClick={() => setDocked(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}
