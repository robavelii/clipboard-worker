/**
 * Paste box.
 *
 * The fallback for everything the share sheet cannot reach: a 2FA code, a
 * field in a password manager, text copied from somewhere that offers no
 * Share action. Open, paste, send.
 *
 * Deliberately a plain textarea rather than a "paste from clipboard" button.
 * Reading the clipboard programmatically triggers iOS's paste-permission
 * banner on every use and needs a permission grant in Chrome; a manual paste
 * into a field prompts for nothing, because the user performing the paste *is*
 * the consent.
 */

import { useState, type FormEvent } from "react";
import { STALE_EPOCH_ERROR } from "@clipsync/protocol";
import { ApiRequestError, type ApiClient } from "@clipsync/client";
import { currentKeys, type RingKeys } from "@clipsync/client/ring";
import { dedupeHash, encryptText } from "@clipsync/crypto";

export function Compose({
  api,
  keys,
  onSent,
  onStale,
}: {
  api: ApiClient;
  keys: RingKeys;
  onSent: () => void;
  /** The vault was re-keyed and this tab missed it: fetch the new key. */
  onStale: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [justSent, setJustSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    const payload = text.trim();
    if (!payload || busy) return;

    setBusy(true);
    setError(null);
    try {
      const current = currentKeys(keys);
      await api.createClip({
        type: "text",
        envelope: await encryptText(current, payload),
        contentHash: await dedupeHash(current, payload),
        size: new TextEncoder().encode(payload).length,
        keyEpoch: keys.current,
      });
      setText("");
      setJustSent(true);
      setTimeout(() => setJustSent(false), 1800);
      // The server does not echo an event back to the device that sent it,
      // so refresh rather than wait for a push that will never arrive.
      onSent();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === STALE_EPOCH_ERROR) {
        // The text stays in the box; once the new key is in, Send works.
        await onStale();
        setError("The vault was re-keyed — press Send again.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="compose" onSubmit={send}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste here to send to your other devices…"
        rows={2}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter keeps a newline, as everywhere else.
          if (e.key === "Enter" && !e.shiftKey) void send(e as unknown as FormEvent);
        }}
      />
      <div className="composebar">
        {error ? (
          <span className="error">{error}</span>
        ) : (
          <span className="muted small">
            {justSent ? "Sent to your devices" : "Enter to send"}
          </span>
        )}
        <button type="submit" disabled={!text.trim() || busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
