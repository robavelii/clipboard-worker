import { useCallback, useEffect, useState } from "react";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import { setUpRecovery } from "@clipsync/client/recovery";
import { DecryptError, openVault, type VaultKey } from "@clipsync/crypto";
import type { RecoveryStatus } from "@clipsync/protocol";
import { RecoveryKeyCard } from "./screens";

type State =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; status: RecoveryStatus };

function message(err: unknown): string {
  if (err instanceof DecryptError) return "That is not this account's passphrase.";
  return err instanceof Error ? err.message : String(err);
}

/**
 * The workspace's recovery key panel (decisions §48): whether the account has
 * one, whether a re-key left it behind, and making, replacing or removing it.
 * Each takes the passphrase; a browser that joined by link or invite never
 * had it, and must be told so rather than offered a dead button.
 */
export function RecoveryPanel({
  api,
  account,
  kdfSalt,
  vaultKey,
  onClose,
  embedded = false,
}: {
  api: ApiClient;
  account: string;
  kdfSalt: string;
  vaultKey: VaultKey;
  onClose?: () => void;
  /** Inside Settings: no frame, heading or close button of its own. */
  embedded?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [action, setAction] = useState<"make" | "remove" | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  const load = useCallback(() => {
    api.recoveryStatus().then(
      (status) => setState({ kind: "ready", status }),
      (err: unknown) =>
        setState(
          err instanceof ApiRequestError && err.status === 404
            ? { kind: "unsupported" }
            : { kind: "failed", message: message(err) },
        ),
    );
  }, [api]);
  useEffect(load, [load]);

  if (shown) {
    return (
      <div className={embedded ? "stack" : "panel"}>
        <RecoveryKeyCard
          recoveryKey={shown}
          onDone={() => {
            setShown(null);
            load();
          }}
        />
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (action === "make") {
        const key = await setUpRecovery(api, { account, passphrase, kdfSalt, vaultKey });
        setShown(key);
      } else {
        const { authProof } = await openVault(passphrase, kdfSalt);
        await api.removeRecovery(authProof);
        load();
      }
      setAction(null);
      setPassphrase("");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const status = state.kind === "ready" ? state.status : null;
  const has = status?.publicKey != null;
  const behind = has && status.epoch !== status.keyEpoch;

  return (
    <div className={embedded ? "stack" : "panel"}>
      {!embedded && (
        <div className="panelhead">
          <h2>Recovery key</h2>
          <button className="link" onClick={onClose}>
            close
          </button>
        </div>
      )}

      {state.kind === "loading" && <p className="muted">Checking…</p>}
      {state.kind === "unsupported" && <p className="muted">This server does not support recovery keys yet.</p>}
      {state.kind === "failed" && <p className="error">{state.message}</p>}

      {status && !has && (
        <p>
          <strong>None.</strong> If you forget the passphrase and lose every device, nothing can open your clips —
          not even the server. A recovery key is the way back in.
        </p>
      )}
      {behind && (
        <p className="error">
          The account was re-keyed after this recovery key was made, so it no longer opens the vault. Make a new
          one.
        </p>
      )}
      {has && !behind && (
        <p>
          <strong>Set up.</strong> It resets the passphrase if you forget it. Replacing it makes the old one useless.
        </p>
      )}

      {status && action === null && (
        <div className="row">
          <button className={has && !behind ? undefined : "primary"} onClick={() => setAction("make")}>
            {has ? "Make a new one" : "Make a recovery key"}
          </button>
          {has && (
            <button className="danger" onClick={() => setAction("remove")}>
              Remove
            </button>
          )}
        </div>
      )}

      {action !== null && (
        <form className="passform" onSubmit={(e) => void submit(e)}>
          <label>
            <span>Passphrase {action === "make" ? "(it proves this is you)" : "to remove it"}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              required
            />
          </label>
          <p className="muted small">
            A browser joined by link or QR code never learned it, but it is still the account's passphrase. The
            CLI does the same: <code>clipsync recovery new</code>.
          </p>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" className={action === "remove" ? "danger" : "primary"} disabled={busy}>
              {busy ? "Working…" : action === "make" ? (has ? "Replace it" : "Make it") : "Remove it"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setAction(null);
                setError(null);
                setPassphrase("");
              }}
            >
              cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
