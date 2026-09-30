/**
 * Minimal service worker.
 *
 * Exists because Android requires a registered worker with a fetch handler
 * before it will treat the site as installable, and installation is what puts
 * ClipSync in the system share sheet. It also receives what is shared, so
 * that nothing shared ever reaches the network before it is encrypted.
 *
 * It deliberately does not cache. Clipboard history is ciphertext fetched with
 * a bearer token; putting any of it in a cache would outlive the tab that
 * holds the key, for no benefit.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== "/share") return;

  // The share sheet (manifest.webmanifest) POSTs what was shared, files and
  // all, as a form. Passed through, that form -- the plaintext -- would
  // travel to the edge. So it is answered here and never forwarded: the
  // share is kept in IndexedDB and the page is sent to pick it up, encrypt
  // it and upload it (decisions §35).
  if (event.request.method === "POST") {
    event.respondWith(stashShare(event.request));
    return;
  }

  // Older installs, whose manifest still says GET, open /share?text=<text>.
  // Answer that navigation with the app shell fetched *without* the query:
  // the page still reads the text from its own location, and the text never
  // leaves the phone.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch("/", { credentials: "same-origin" }));
  }
  // Everything else passes through to the network.
});

/*
 * Shares waiting for the page. The page reads and deletes them through
 * src/shares.ts, which must name the same database and store.
 */
const SHARE_DB = "clipsync-shares";
const SHARE_STORE = "shares";

function openShares() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(SHARE_STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stashShare(request) {
  const back = (query) => Response.redirect(new URL(`/share?${query}`, self.location.origin).href, 303);
  try {
    const form = await request.formData();
    const field = (name) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const share = {
      title: field("title"),
      text: field("text"),
      url: field("url"),
      files: form.getAll("files").filter((f) => typeof f !== "string" && f.size > 0),
      at: Date.now(),
    };
    const db = await openShares();
    try {
      const id = await new Promise((resolve, reject) => {
        const req = db.transaction(SHARE_STORE, "readwrite").objectStore(SHARE_STORE).add(share);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return back(`pending=${id}`);
    } finally {
      db.close();
    }
  } catch {
    // Still never forwarded: the page says it could not be received.
    return back("failed");
  }
}
