import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Self-hosted, so the CSP stays 'self' only: Host Grotesk for what a person
// reads, Atkinson Hyperlegible Mono for what was copied and when.
import "@fontsource/host-grotesk/latin-400.css";
import "@fontsource/host-grotesk/latin-500.css";
import "@fontsource/atkinson-hyperlegible-mono/latin-400.css";
import "@fontsource/atkinson-hyperlegible-mono/latin-500.css";
import "./styles.css";

// Installability is what puts ClipSync in Android's share sheet.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Not fatal: the app works fine uninstalled, just without share target.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
