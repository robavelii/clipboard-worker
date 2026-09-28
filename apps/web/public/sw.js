/**
 * Minimal service worker.
 *
 * Exists because Android requires a registered worker with a fetch handler
 * before it will treat the site as installable, and installation is what puts
 * ClipSync in the system share sheet.
 *
 * It deliberately does not cache. Clipboard history is ciphertext fetched with
 * a bearer token; putting any of it in a cache would outlive the tab that
 * holds the key, for no benefit.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Android's share sheet opens GET /share?text=<plaintext>. Passed through,
  // that query string -- the clip itself, unencrypted -- would travel to the
  // edge and into whatever logs it keeps. So answer the navigation with the
  // app shell fetched *without* the query: the page still reads the text from
  // its own location, and the text never leaves the phone.
  if (
    event.request.mode === "navigate" &&
    url.origin === self.location.origin &&
    url.pathname === "/share"
  ) {
    event.respondWith(fetch("/", { credentials: "same-origin" }));
  }
  // Everything else passes through to the network.
});
