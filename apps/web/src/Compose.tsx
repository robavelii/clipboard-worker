/**
 * Paste box.
 *
 * The fallback for everything the share sheet cannot reach: a 2FA code, a
 * field in a password manager, text copied from somewhere that offers no
 * Share action. Open, paste, send. Images and files go the same way: attach
 * one, paste a screenshot, or drop a file on the box.
 *
 * Deliberately a plain textarea rather than a "paste from clipboard" button.
 * Reading the clipboard programmatically triggers iOS's paste-permission
 * banner on every use and needs a permission grant in Chrome; a manual paste
 * into a field prompts for nothing, because the user performing the paste *is*
 * the consent.
 */

import { useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { R2_BUDGET_ERROR, STALE_EPOCH_ERROR } from "@clipsync/protocol";
import { ApiRequestError, type ApiClient } from "@clipsync/client";
import { uploadFile } from "@clipsync/client/files";
import { sealText, type RingKeys } from "@clipsync/client/ring";
import { formatBytes } from "./FileView";

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

  async function run(label: string, work: () => Promise<unknown>, onDone?: () => void) {
    setBusy(label);
    setError(null);
    try {
      await work();
      onDone?.();
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
      async () => api.createClip(await sealText(keys, account, deviceId, payload)),
      () => setText(""),
    );
  }

  function sendFile(file: File) {
    if (busy) return;
    void run(`Uploading ${file.name}…`, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await uploadFile(api, keys, account, deviceId, {
        name: file.name || "pasted-image",
        mime: file.type,
        bytes,
      }, (sent) => setBusy(`Uploading ${file.name}… ${formatBytes(sent)} of ${formatBytes(bytes.length)}`));
    });
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // A pasted screenshot arrives as a file; pasted text goes in the box.
    const file = [...event.clipboardData.files][0];
    if (file) {
      event.preventDefault();
      sendFile(file);
    }
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    const file = [...event.dataTransfer.files][0];
    if (file) {
      event.preventDefault();
      sendFile(file);
    }
  }

  return (
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
              if (file) sendFile(file);
            }}
          />
        </label>
        <button type="submit" disabled={!text.trim() || Boolean(busy)}>
          {busy === "Sending…" ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
