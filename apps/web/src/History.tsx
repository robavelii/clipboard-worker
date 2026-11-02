import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@clipsync/client";
import type { RingKeys } from "@clipsync/client/ring";
import type { DecryptedClip } from "@clipsync/react";
import { canCopy, copyClip } from "./clipboard";
import { FileView } from "./FileView";
import { ago, bytes, expiresIn } from "./time";

/** How long a deleted clip can be brought back before the server forgets it. */
const UNDO_MS = 6000;

function useWide(query = "(min-width: 60rem)"): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

/** Typing in a field, or a shortcut with a modifier: not ours. */
function ignoreKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  return Boolean(el?.closest("input, textarea, select, [contenteditable='true'], dialog, details[open]"));
}

function firstLines(text: string, max = 180): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * The clipboard history: a list of copies beside the one being looked at.
 * On a wide screen the selected clip opens in a pane on the right; on a
 * narrow one it opens in place, under its row. The keyboard works the list
 * the way a clipboard manager does: arrows or j/k to move, Enter or c to
 * copy, p to pin, Delete to delete (with a few seconds to undo).
 */
export function History({
  clips,
  api,
  keys,
  account,
  deviceId,
  deviceNames,
  onDelete,
  onTogglePin,
  emptyText,
}: {
  clips: DecryptedClip[];
  api: ApiClient;
  keys: RingKeys;
  account: string;
  deviceId: string;
  deviceNames: Map<string, string>;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  emptyText: string | null;
}) {
  const wide = useWide();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; label: string } | null>(null);
  const timer = useRef<number | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const shown = useMemo(() => clips.filter((c) => c.id !== pending?.id), [clips, pending]);
  const selected = shown.find((c) => c.id === selectedId) ?? (wide ? shown[0] : undefined) ?? null;

  const origin = useCallback(
    (clip: DecryptedClip) =>
      clip.deviceId === deviceId ? "This browser" : (deviceNames.get(clip.deviceId) ?? "A removed device"),
    [deviceId, deviceNames],
  );

  // A delete waits out its undo window, then goes to the server; leaving
  // the screen sends it at once. Stable, so only an unmount commits early.
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;
  const commit = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const was = pendingRef.current;
    if (was) {
      pendingRef.current = null;
      setPending(null);
      deleteRef.current(was.id);
    }
  }, []);
  useEffect(() => commit, [commit]);

  const remove = useCallback(
    (clip: DecryptedClip) => {
      commit();
      const index = shown.findIndex((c) => c.id === clip.id);
      const next = shown[index + 1] ?? shown[index - 1];
      setSelectedId(next?.id ?? null);
      setPending({ id: clip.id, label: clip.file ? clip.file.name : "Clip" });
      timer.current = window.setTimeout(commit, UNDO_MS);
    },
    [commit, shown],
  );

  const undo = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (pending) setSelectedId(pending.id);
    setPending(null);
  };

  const move = useCallback(
    (step: number) => {
      if (!shown.length) return;
      const at = selected ? shown.findIndex((c) => c.id === selected.id) : -1;
      const next = shown[Math.min(shown.length - 1, Math.max(0, at + step))]!;
      setSelectedId(next.id);
      rows.current.get(next.id)?.focus({ preventScroll: false });
    },
    [shown, selected],
  );

  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const copy = useCallback(
    (clip: DecryptedClip) => {
      // Straight from the key press or tap: iOS refuses a write made after an await.
      copyClip(api, keys, account, clip).then(
        () => setCopied({ id: clip.id, ok: true }),
        () => setCopied({ id: clip.id, ok: false }),
      );
      window.setTimeout(() => setCopied((c) => (c?.id === clip.id ? null : c)), 1600);
    },
    [api, keys, account],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ignoreKey(e)) return;
      if (e.key === "ArrowDown" || e.key === "j") move(1);
      else if (e.key === "ArrowUp" || e.key === "k") move(-1);
      else if ((e.key === "Enter" || e.key === "c") && selected && canCopy(selected)) copy(selected);
      else if (e.key === "p" && selected) onTogglePin(selected.id, !selected.pinned);
      else if ((e.key === "Delete" || e.key === "Backspace") && selected) remove(selected);
      else if (e.key === "z" && pendingRef.current) undo();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const detail = selected && (
    <ClipDetail
      clip={selected}
      api={api}
      keys={keys}
      account={account}
      origin={origin(selected)}
      copied={copied?.id === selected.id ? copied.ok : null}
      onCopy={() => copy(selected)}
      onTogglePin={() => onTogglePin(selected.id, !selected.pinned)}
      onDelete={() => remove(selected)}
    />
  );

  return (
    <>
      <div className="history">
        {emptyText !== null && !shown.length ? (
          <p className="empty">{emptyText}</p>
        ) : (
          <ul className="ledger" aria-label="Clipboard history">
            {shown.map((clip) => {
              const on = selected?.id === clip.id;
              return (
                <li key={clip.id} className={on ? "entry on" : "entry"}>
                  <button
                    type="button"
                    className="entry-row"
                    aria-expanded={wide ? undefined : on}
                    aria-current={on ? "true" : undefined}
                    ref={(el) => {
                      if (el) rows.current.set(clip.id, el);
                      else rows.current.delete(clip.id);
                    }}
                    onClick={() => setSelectedId(on && !wide ? null : clip.id)}
                  >
                    <span className={clip.text === null ? "entry-text locked" : "entry-text"}>
                      {clip.file ? (
                        <>
                          <span className="kind">{clip.type === "image" ? "Image" : "File"}</span>
                          {clip.file.name}
                        </>
                      ) : clip.text === null ? (
                        "Can't be opened on this device"
                      ) : (
                        firstLines(clip.text)
                      )}
                    </span>
                    <span className="entry-side">
                      <time dateTime={new Date(clip.createdAt).toISOString()}>{ago(clip.createdAt)}</time>
                      <span className="entry-origin">{origin(clip)}</span>
                      {clip.pinned && <span className="tag">Pinned</span>}
                    </span>
                  </button>
                  {!wide && on && <div className="inline-detail">{detail}</div>}
                </li>
              );
            })}
          </ul>
        )}
        {wide && <aside className="pane" aria-label="Selected clip">{detail ?? <p className="muted">Pick a clip to see all of it.</p>}</aside>}
      </div>

      <div className="toast-region" role="status" aria-live="polite">
        {pending && (
          <div className="toast">
            <span>{pending.label} deleted.</span>
            <button type="button" onClick={undo}>
              Undo
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function ClipDetail({
  clip,
  api,
  keys,
  account,
  origin,
  copied,
  onCopy,
  onTogglePin,
  onDelete,
}: {
  clip: DecryptedClip;
  api: ApiClient;
  keys: RingKeys;
  account: string;
  origin: string;
  copied: boolean | null;
  onCopy: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const expiry = clip.pinned ? null : expiresIn(clip.expiresAt);
  return (
    <div className="detail">
      <div className="detail-actions">
        {(!clip.file || canCopy(clip)) && (
          <button type="button" className="primary" onClick={onCopy} disabled={!canCopy(clip)} aria-keyshortcuts="c">
            {copied === null ? "Copy" : copied ? "Copied" : "Copy failed"}
          </button>
        )}
        <button type="button" onClick={onTogglePin} aria-keyshortcuts="p" title="Pinned clips never expire">
          {clip.pinned ? "Unpin" : "Pin"}
        </button>
        <span className="grow" />
        <button type="button" className="quiet-danger" onClick={onDelete} aria-keyshortcuts="Delete">
          Delete
        </button>
      </div>
      {clip.file ? (
        <FileView api={api} keys={keys} account={account} clip={clip} />
      ) : (
        <pre className={clip.text === null ? "detail-text locked" : "detail-text"}>
          {clip.text ?? "This clip was encrypted under a key this device doesn’t hold."}
        </pre>
      )}
      <dl className="facts">
        <div>
          <dt>From</dt>
          <dd>{origin}</dd>
        </div>
        <div>
          <dt>Copied</dt>
          <dd className="measured">{new Date(clip.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd className="measured">{clip.file ? bytes(clip.file.size) : `${(clip.text ?? "").length} characters`}</dd>
        </div>
        <div>
          <dt>Kept</dt>
          <dd className={expiry ? "measured warn" : "measured"}>
            {clip.pinned
              ? "Pinned, never expires"
              : clip.expiresAt
                ? (expiry ?? `until ${new Date(clip.expiresAt).toLocaleDateString()}`)
                : "Until deleted"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
