/**
 * Landing page for a scanned invite: /join#<inviteId>.<secret>
 *
 * The secret sits in the fragment, which browsers never transmit, so the
 * Worker serves this page without ever learning what opens the payload.
 *
 * Nothing is asked for except a device name. That is the point: the vault key
 * arrives sealed under the secret from the QR, so there is no passphrase to
 * type and no code to compare.
 */

import { useState, type FormEvent } from "react";
import { ApiClient } from "@clipsync/client";
import { claimInvite } from "@clipsync/client/invite";
import { cacheVaultKey, saveCredentials } from "./session";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

export function JoinScreen({
  inviteId,
  secret,
  onJoined,
}: {
  inviteId: string;
  secret: string;
  onJoined: () => void;
}) {
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { credentials, vaultKey } = await claimInvite(
        new ApiClient(""),
        inviteId,
        secret,
        name,
        /iPhone|iPad|Android/.test(navigator.userAgent) ? "other" : "web",
      );

      saveCredentials(credentials);
      cacheVaultKey(vaultKey);
      // Drop the secret from the address bar so a screenshot or a shared
      // history entry cannot replay it.
      window.history.replaceState(null, "", "/");
      onJoined();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "This invite could not be used. Ask for a fresh one.",
      );
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Join ClipSync</h1>
      <p className="muted">
        This invite carries the key already — there is no passphrase to enter.
      </p>

      <label>
        Name this device
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          required
        />
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={busy}>
        {busy ? "Joining…" : "Join"}
      </button>

      <p className="muted small">
        Invites last five minutes and work once. If this fails, run{" "}
        <code>clipsync invite</code> again.
      </p>
    </form>
  );
}

/** Parses /join#<inviteId>.<secret> out of the current location. */
export function readInviteFromLocation(): {
  inviteId: string;
  secret: string;
} | null {
  if (window.location.pathname !== "/join") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const dot = hash.indexOf(".");
  if (dot < 1) return null;
  return { inviteId: hash.slice(0, dot), secret: hash.slice(dot + 1) };
}
