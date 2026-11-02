import { useEffect, useState } from "react";
import type { ApiClient } from "@clipsync/client";
import type { Device } from "@clipsync/protocol";
import type { Section } from "./Settings";

const DISMISSED = "clipsync.setupDismissed";

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

interface Step {
  done: boolean;
  label: string;
  hint: string;
  action: string;
  run: () => void;
}

/**
 * Getting started, on the workspace until each step is done or the owner hides
 * it: a second device (the point of the product), a recovery key (the only way
 * back from a forgotten passphrase) and an email address (where sign-in and
 * deletion codes go). Each step is read from the server, so it ticks itself
 * off wherever it was done.
 */
export function Checklist({
  api,
  devices,
  onAddDevice,
  onSettings,
}: {
  api: ApiClient;
  devices: Device[];
  onAddDevice: () => void;
  onSettings: (section: Section) => void;
}) {
  const [hidden, setHidden] = useState(dismissed);
  const [recovery, setRecovery] = useState<boolean | null>(null);
  const [email, setEmail] = useState<boolean | null>(null);

  useEffect(() => {
    if (hidden) return;
    api.recoveryStatus().then(
      (s) => setRecovery(s.publicKey !== null && s.epoch === s.keyEpoch),
      () => setRecovery(null),
    );
    api.me().then(
      // Servers from before addresses don't report one: leave the step out.
      (me) => setEmail(me.email === undefined ? null : me.email !== null),
      () => setEmail(null),
    );
  }, [api, hidden]);

  if (hidden || devices.length === 0) return null;

  const steps: Step[] = [
    {
      done: devices.length > 1,
      label: "Add a second device",
      hint: "Install the agent on a computer, or open this site on your phone.",
      action: "Add device",
      run: onAddDevice,
    },
    ...(recovery === null
      ? []
      : [
          {
            done: recovery,
            label: "Save a recovery key",
            hint: "If you forget the passphrase, it is the only way back to your clips.",
            action: "Make one",
            run: () => onSettings("security"),
          },
        ]),
    ...(email === null
      ? []
      : [
          {
            done: email,
            label: "Add an email address",
            hint: "For signing in on a new browser and confirming account changes.",
            action: "Add",
            run: () => onSettings("account"),
          },
        ]),
  ];

  const left = steps.filter((s) => !s.done).length;
  if (left === 0) return null;

  return (
    <section className="checklist" aria-label="Getting started">
      <div className="checklist-head">
        <h2>Getting started</h2>
        <span className="muted small">
          {steps.length - left} of {steps.length} done
        </span>
        <span className="grow" />
        <button
          className="link"
          onClick={() => {
            try {
              localStorage.setItem(DISMISSED, "1");
            } catch {
              /* private mode: hidden for this visit only */
            }
            setHidden(true);
          }}
        >
          Hide
        </button>
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step.label} className={step.done ? "done" : undefined}>
            <span className="check" aria-hidden="true" />
            <div className="grow">
              <strong>{step.label}</strong>
              {!step.done && <small>{step.hint}</small>}
            </div>
            {!step.done && <button onClick={step.run}>{step.action}</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}
