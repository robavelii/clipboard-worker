/**
 * An image or file clip: its name and size, a preview for images, and a
 * download. The bytes come from R2 and are decrypted here; every fetch
 * spends from the Worker's free-tier budget, so decrypted files are kept for
 * the page's lifetime instead of being fetched again on every render.
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "@clipsync/client";
import { downloadFile } from "@clipsync/client/files";
import type { RingKeys } from "@clipsync/client/ring";
import type { DecryptedClip } from "@clipsync/react";

/** Images up to this size preview on their own; bigger ones on request. */
const AUTO_PREVIEW_BYTES = 5 * 1024 * 1024;

export interface FetchedFile {
  blob: Blob;
  /** An object URL for the blob, for previews and downloads. */
  url: string;
}

/** Files already fetched this session, by clip id. */
const fetched = new Map<string, Promise<FetchedFile>>();

/**
 * Fetch and decrypt a file clip, once per page. The blob is kept beside its
 * URL because the page cannot fetch its own blob: URLs back (the CSP's
 * connect-src is 'self' only).
 */
export function fetchFile(
  api: ApiClient,
  keys: RingKeys,
  account: string,
  clip: DecryptedClip,
): Promise<FetchedFile> {
  let file = fetched.get(clip.id);
  if (!file) {
    file = downloadFile(api, keys, clip, account).then(({ meta, bytes }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: meta.mime });
      return { blob, url: URL.createObjectURL(blob) };
    });
    // A failure is not cached: the next attempt tries again.
    file.catch(() => fetched.delete(clip.id));
    fetched.set(clip.id, file);
  }
  return file;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileView({
  api,
  keys,
  account,
  clip,
}: {
  api: ApiClient;
  keys: RingKeys;
  account: string;
  clip: DecryptedClip;
}) {
  const meta = clip.file!;
  const isImage = clip.type === "image";
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      const { url: got } = await fetchFile(api, keys, account, clip);
      setUrl(got);
      return got;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (isImage && meta.size <= AUTO_PREVIEW_BYTES) void load();
    // Once per clip: `load` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  const save = async () => {
    const href = url ?? (await load());
    if (!href) return;
    const a = document.createElement("a");
    a.href = href;
    a.download = meta.name;
    a.click();
  };

  return (
    <div className="fileclip">
      {isImage && url && <img className="preview" src={url} alt={meta.name} />}
      <div className="fileinfo">
        <span className="filename">{meta.name}</span>
        <span className="muted small">
          {formatBytes(meta.size)}
          {busy ? " · loading…" : ""}
        </span>
        {isImage && !url && !busy && (
          <button className="link" onClick={() => void load()}>
            Show image
          </button>
        )}
        <button onClick={() => void save()} disabled={busy}>
          Download
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
