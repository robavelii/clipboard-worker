import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import type { ApiClient } from "@clipsync/client";
import { createInvite, type Invite } from "@clipsync/client/invite";
import type { Device } from "@clipsync/protocol";

/**
 * The QR as one SVG path, built from the code's modules: no innerHTML and no
 * style attribute, so the CSP's style-src 'self' holds. Colours come from
 * classes; the code is always dark on light, which every phone camera reads.
 */
function QrSvg({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
    let d = "";
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.data[y * modules.size + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
      }
    }
    return { size: modules.size + 8, path: d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="qr-paper" width={size} height={size} />
      <path className="qr-ink" d={path} />
    </svg>
  );
}

function minutesLeft(at: number): number {
  return Math.max(0, Math.ceil((at - Date.now()) / 60_000));
}

/**
 * Adding a device, QR first (decisions §52): this browser makes a one-scan
 * invite, the same as `clipsync invite`, and shows it as a code the phone's
 * camera opens. The phone gets the vault key from the code itself, so nobody
 * types the passphrase. A computer can paste a link from `clipsync link`, or
 * fall back to a pairing code.
 */
export function AddDevice({
  api,
  vaultKey,
  devices,
  onClose,
}: {
  api: ApiClient;
  vaultKey: string;
  devices: Device[];
  onClose: () => void;
}) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [joined, setJoined] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [pairCode, setPairCode] = useState<string | null>(null);
  const known = useRef(new Set(devices.map((d) => d.id)));

  const make = useCallback(() => {
    setError(null);
    setInvite(null);
    // The API answers on this origin; the link names it so the phone opens it here.
    createInvite(api, window.location.origin, vaultKey).then(setInvite, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [api, vaultKey]);
  useEffect(make, [make]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  // A device that wasn't here when the panel opened is the one that scanned.
  useEffect(() => {
    const fresh = devices.find((d) => !known.current.has(d.id));
    if (fresh) setJoined(fresh.name);
  }, [devices]);

  const expired = invite !== null && invite.expiresAt <= now;
  const [copied, setCopied] = useState(false);

  return (
    <section className="notice adddevice" aria-label="Add a device">
      <div className="panelhead">
        <h2>Add a device</h2>
        <button type="button" className="link" onClick={onClose}>
          Done
        </button>
      </div>

      {joined ? (
        <p className="ok">
          <strong>{joined}</strong> joined. It has your clipboard now, and nobody typed the passphrase.
        </p>
      ) : (
        <div className="adddevice-body">
          <div className="qrbox">
            {invite && !expired ? (
              <QrSvg text={invite.url} label="QR code that adds a phone to ClipSync" />
            ) : (
              <div className="qr qr-wait" aria-hidden="true" />
            )}
          </div>
          <div className="adddevice-text">
            <p>
              <strong>Point your phone’s camera at the code</strong> and open the link. It joins straight away, with
              no passphrase to type.
            </p>
            {error && <p className="error">{error}</p>}
            {!invite && !error && <p className="muted small">Making a code…</p>}
            {invite && !expired && (
              <p className="muted small">
                Works once, for {minutesLeft(invite.expiresAt)} more minute{minutesLeft(invite.expiresAt) === 1 ? "" : "s"}.
                Anyone who scans it gets your clipboard, so show it only to your own phone.
              </p>
            )}
            {(expired || error) && (
              <div className="row">
                <button type="button" className="primary" onClick={make}>
                  Make a new code
                </button>
              </div>
            )}
            {invite && !expired && (
              <div className="row">
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(invite.url).then(() => setCopied(true), () => setCopied(false));
                  }}
                >
                  {copied ? "Link copied" : "Copy the link instead"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!joined && (
        <details className="other-ways" open={other} onToggle={(e) => setOther(e.currentTarget.open)}>
          <summary>Adding a computer?</summary>
          <div className="stack">
            <p className="small">
              Install it with <code>curl -fsSL {window.location.origin}/install.sh | sh</code> (or{" "}
              <code>clipsync link</code>), then paste the link it prints:
            </p>
            <form
              className="linkform"
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  const url = new URL(linkUrl.trim());
                  window.location.href = `/link${url.hash}`;
                } catch {
                  /* ignore malformed input; the field stays put */
                }
              }}
            >
              <label htmlFor="link-url" className="visually-hidden">
                Link from clipsync link
              </label>
              <input
                id="link-url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder={`${window.location.origin}/link#…`}
              />
              <button type="submit">Open</button>
            </form>
            {pairCode ? (
              <p className="small">
                Pairing code (that device then asks for the passphrase; once, for 10 minutes):{" "}
                <span className="code measured">{pairCode}</span>
              </p>
            ) : (
              <p className="small">
                <button type="button" className="link" onClick={() => void api.pairCode().then((r) => setPairCode(r.code), () => undefined)}>
                  Use a pairing code instead
                </button>
              </p>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
