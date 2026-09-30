/**
 * Shares the service worker kept for the page (public/sw.js, decisions §35).
 *
 * The share sheet POSTs to /share; the service worker stores the form here
 * and redirects to /share?pending=<id>. The page encrypts and uploads it,
 * then deletes it, so plaintext sits on the phone only until it is sent.
 * One the page never gets to (left locked, abandoned) is dropped after a day.
 */

/** Must match public/sw.js. */
const SHARE_DB = "clipsync-shares";
const SHARE_STORE = "shares";

/** How long an unsent share is kept. */
const KEEP_MS = 24 * 60 * 60 * 1000;

export interface PendingShare {
  title: string;
  text: string;
  url: string;
  files: File[];
  /** When it was shared, in ms since the epoch. */
  at: number;
}

/** What /share was opened with. */
export type ShareSource =
  | { kind: "text"; text: string }
  | { kind: "pending"; id: number }
  /** The service worker could not store the share. */
  | { kind: "failed" };

function openShares(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(SHARE_STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withShares<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openShares();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(SHARE_STORE, mode).objectStore(SHARE_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadPendingShare(id: number): Promise<PendingShare | null> {
  const share = await withShares<PendingShare | undefined>("readonly", (s) => s.get(id));
  return share ?? null;
}

export async function deletePendingShare(id: number): Promise<void> {
  await withShares("readwrite", (s) => s.delete(id));
}

/** Drop shares nobody sent within a day. Best effort. */
export async function dropStaleShares(now = Date.now()): Promise<void> {
  try {
    const db = await openShares();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, "readwrite");
        const req = tx.objectStore(SHARE_STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const share = cursor.value as PendingShare;
          if (!(now - share.at < KEEP_MS)) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // No IndexedDB (some private modes): nothing was stored either.
  }
}

/**
 * Title, text and url as one clip. A shared link often arrives as both
 * `text` and `url` with the same value, so repeats are dropped.
 */
export function joinShared(parts: (string | null | undefined)[]): string | null {
  const unique = [
    ...new Set(parts.map((v) => v?.trim()).filter((v): v is string => Boolean(v))),
  ];
  return unique.length ? unique.join("\n") : null;
}

/**
 * What this page was opened with, if it is /share.
 *
 *   - `?pending=<id>`: a share the service worker stored (the share sheet).
 *   - `?failed`: one it could not store, or one that reached the Worker.
 *   - `#text=<text>`: the iOS Shortcut. Everything after `text=` is the text,
 *     so an `&` the Shortcut left unencoded does not cut it short.
 *   - `?title=&text=&url=`: the share sheet of an install from before
 *     files, whose manifest still says GET.
 */
export function readShareSource(location: Location = window.location): ShareSource | null {
  if (location.pathname !== "/share") return null;
  const q = new URLSearchParams(location.search);

  const pending = q.get("pending");
  if (pending !== null) {
    const id = Number(pending);
    return Number.isSafeInteger(id) ? { kind: "pending", id } : { kind: "failed" };
  }
  if (q.has("failed")) return { kind: "failed" };

  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("text=")) {
    const text = joinShared([decode(hash.slice("text=".length))]);
    if (text) return { kind: "text", text };
  }

  const text = joinShared([q.get("title"), q.get("text"), q.get("url")]);
  return text ? { kind: "text", text } : null;
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    // A stray `%` the Shortcut did not encode: the text as it came.
    return raw;
  }
}
