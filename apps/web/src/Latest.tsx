/**
 * "Copy latest": on a phone, the newest clip from another device, one tap
 * from the clipboard.
 *
 * A phone has no agent to apply other devices' copies, and no page may write
 * the clipboard without a tap, so the tap is kept to one. Images are copied
 * as images; other files can only be downloaded.
 */

import { useState } from "react";
import type { ApiClient } from "@clipsync/client";
import type { RingKeys } from "@clipsync/client/ring";
import type { DecryptedClip } from "@clipsync/react";
import { canCopy, copyClip } from "./clipboard";
import { FileView } from "./FileView";

/** The newest clip another device wrote, if any. */
export function latestFromElsewhere(
  clips: DecryptedClip[],
  deviceId: string,
): DecryptedClip | null {
  let latest: DecryptedClip | null = null;
  for (const clip of clips) {
    if (clip.deviceId === deviceId) continue;
    if (!latest || clip.createdAt > latest.createdAt) latest = clip;
  }
  return latest;
}

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

export function LatestCard({
  clip,
  api,
  keys,
  account,
  origin,
}: {
  clip: DecryptedClip;
  api: ApiClient;
  keys: RingKeys;
  account: string;
  origin: string;
}) {
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const done = copied?.id === clip.id ? copied : null;

  function copy() {
    // Straight from the tap: iOS refuses a clipboard write made after an await.
    copyClip(api, keys, account, clip).then(
      () => setCopied({ id: clip.id, ok: true }),
      () => setCopied({ id: clip.id, ok: false }),
    );
  }

  return (
    <section className="latest" aria-label="Latest from your other devices">
      <div className="latesthead">
        <span className="muted small">
          Latest from {origin} · {ago(clip.createdAt)}
        </span>
        {canCopy(clip) && (
          <button className="primary" onClick={copy}>
            {done ? (done.ok ? "Copied" : "Copy failed") : "Copy"}
          </button>
        )}
      </div>
      {clip.file ? (
        <FileView api={api} keys={keys} account={account} clip={clip} />
      ) : (
        <pre className={clip.text === null ? "latesttext locked" : "latesttext"}>
          {clip.text ?? "Cannot decrypt on this device"}
        </pre>
      )}
    </section>
  );
}
