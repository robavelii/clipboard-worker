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
self.addEventListener("fetch", () => {
  // Pass through to the network. Present only to satisfy installability.
});
