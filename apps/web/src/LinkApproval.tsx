/**
 * Approval screen for `clipsync link`.
 *
 * Reached at /link#<linkId>.<publicKey>. The public key rides in the fragment,
 * which browsers never send to the server -- so the key this page seals to is
 * the one that came off the QR, not one the server chose.
 */

import { useEffect, useState } from "react";
import { approveLink, inspectLink } from "@clipsync/client/link";
import { fingerprint } from "@clipsync/crypto";
import type { LinkStatusResponse } from "@clipsync/protocol";

type State =
  | { phase: "loading" }
  | { phase: "ready"; status: LinkStatusResponse; code: string }
  | { phase: "approving" }
  | { phase: "done"; deviceName: string }
  | { phase: "error"; message: string };

export function LinkApproval({
  linkId,
  publicKey,
  token,
  vaultKey,
  onClose,
}: {
  linkId: string;
  publicKey: string;
  token: string;
  /** Sealed to the joining device. It never learns the passphrase. */
  vaultKey: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await inspectLink("", token, linkId);
        // Refuse before showing anything if the server returned a different
        // key than the one that arrived out of band.
        if (status.publicKey !== publicKey) {
          throw new Error(
            "The key this server returned does not match the one in your link. " +
              "Do not approve — this is what a tampered link looks like.",
          );
        }
        const code = await fingerprint(publicKey);
        if (!cancelled) setState({ phase: "ready", status, code });
      } catch (err) {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [linkId, publicKey, token]);

  async function approve() {
    setState({ phase: "approving" });
    try {
      const { deviceName } = await approveLink(
        "",
        token,
        linkId,
        publicKey,
        vaultKey,
      );
      setState({ phase: "done", deviceName });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (state.phase === "loading") {
    return (
      <div className="card">
        <h1>Checking request…</h1>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="card">
        <h1>Cannot approve</h1>
        <p className="error">{state.message}</p>
        <button onClick={onClose}>Back</button>
      </div>
    );
  }

  if (state.phase === "done") {
    return (
      <div className="card">
        <h1>Approved</h1>
        <p className="muted">
          “{state.deviceName}” is set up and can start syncing. Nobody typed
          the passphrase on it — and it never learned one.
        </p>
        <button onClick={onClose}>Done</button>
      </div>
    );
  }

  if (state.phase === "approving") {
    return (
      <div className="card">
        <h1>Approving…</h1>
        <p className="muted">Sealing your passphrase to that device.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Approve this device?</h1>

      <dl className="kv">
        <dt>Name</dt>
        <dd>{state.status.deviceName}</dd>
        <dt>Platform</dt>
        <dd>{state.status.platform}</dd>
      </dl>

      <p className="muted">Confirm this code matches the other device:</p>
      <p className="fingerprint">{state.code}</p>

      <p className="muted small">
        Approving sends that device your vault key, encrypted so only it can
        read it. It will be able to read your clipboard, but not to change
        your passphrase. If the codes differ, do not approve.
      </p>

      <button onClick={() => void approve()}>Approve</button>
      <button className="link" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/** Parses /link#<linkId>.<publicKey> out of the current location. */
export function readLinkFromLocation(): {
  linkId: string;
  publicKey: string;
} | null {
  if (window.location.pathname !== "/link") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const dot = hash.indexOf(".");
  if (dot < 1) return null;
  return { linkId: hash.slice(0, dot), publicKey: hash.slice(dot + 1) };
}
