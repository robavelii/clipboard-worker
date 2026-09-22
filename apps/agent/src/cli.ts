/** clipsync — command line entry point. */

import { hostname, platform as osPlatform } from "node:os";
import { parseArgs } from "node:util";
import type { Platform } from "@clipsync/protocol";
import { decryptText, deriveKeys } from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import {
  approveLink,
  awaitApproval,
  beginLink,
  inspectLink,
  parseLinkUrl,
} from "@clipsync/client/link";
import { fingerprint } from "@clipsync/crypto";
import { toString as qrToString } from "qrcode";
import { detectClipboard } from "./clipboard";
import {
  clearConfig,
  configPath,
  loadConfig,
  requireConfig,
  resolvePassphrase,
  saveConfig,
} from "./config";
import { Daemon } from "./daemon";
import { ask, askNewPassphrase, askSecret, closePrompts } from "./prompt";

const USAGE = `clipsync — encrypted clipboard sync

Usage
  clipsync login --url <worker-url> [--name <device>]   Create the account, enrol this device
  clipsync link --url <url> [--name <device>]           Join by QR -- no passphrase typing
  clipsync approve <link-url>                           Approve a device that ran 'clipsync link'
  clipsync pair <code> --url <url> [--name <device>]    Join using a pairing code (manual)
  clipsync pair-code                                    Mint a code for another device
  clipsync run [--push-current] [--verbose]             Watch the clipboard and sync
  clipsync history [-n <count>]                         Show recent clips
  clipsync copy <clip-id>                               Copy a clip to this clipboard
  clipsync devices [--revoke <id>]                      List or revoke devices
  clipsync status                                       Show current configuration
  clipsync logout                                       Forget local credentials
`;

function currentPlatform(): Platform {
  switch (osPlatform()) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}

function relativeTime(ts: number | null): string {
  if (!ts) return "never";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function preview(text: string, width = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/* ------------------------------ commands ------------------------------- */

async function cmdLogin(opts: { url?: string; name?: string }): Promise<void> {
  const baseUrl = opts.url ?? (await ask("Worker URL: "));
  if (!baseUrl) throw new Error("--url is required");

  const deviceName = opts.name ?? hostname();
  const adminSecret = await askSecret("Admin secret: ");
  const passphrase = await askNewPassphrase();

  const creds = await new ApiClient(baseUrl).bootstrap(
    adminSecret,
    deviceName,
    currentPlatform(),
  );

  await saveConfig({ baseUrl, deviceName, passphrase, ...creds });
  console.log(`Enrolled "${deviceName}" (${creds.deviceId}).`);
  console.log(`Credentials written to ${configPath()}.`);
  console.log(`\nNext: clipsync run`);
}

async function cmdPair(
  code: string | undefined,
  opts: { url?: string; name?: string },
): Promise<void> {
  if (!code) throw new Error("usage: clipsync pair <code> --url <worker-url>");

  const baseUrl = opts.url ?? (await ask("Worker URL: "));
  if (!baseUrl) throw new Error("--url is required");

  const deviceName = opts.name ?? hostname();
  console.log(
    "Enter the same passphrase you used on your other devices —\n" +
      "clips encrypted under a different one will not decrypt here.",
  );
  const passphrase = await askNewPassphrase();

  const creds = await new ApiClient(baseUrl).pair(
    code,
    deviceName,
    currentPlatform(),
  );

  await saveConfig({ baseUrl, deviceName, passphrase, ...creds });
  console.log(`Paired "${deviceName}" (${creds.deviceId}).`);

  // Immediate feedback on a mistyped passphrase beats silent garbage later.
  const api = new ApiClient(baseUrl, creds.token);
  const { clips } = await api.listClips(1);
  const sample = clips[0];
  if (sample) {
    const keys = await deriveKeys(passphrase, creds.kdfSalt);
    try {
      await decryptText(keys, sample.envelope);
      console.log("Passphrase verified against existing history.");
    } catch {
      console.warn(
        "\nWARNING: this passphrase does not decrypt existing clips.\n" +
          "Re-run `clipsync pair` with the right one, or history will look empty.",
      );
    }
  }
  console.log(`\nNext: clipsync run`);
}

/**
 * Join an existing account without typing the passphrase.
 *
 * Shows a QR containing this device's ephemeral public key. An already-set-up
 * device scans or pastes it, checks the fingerprint, and seals the passphrase
 * back. The server relays ciphertext it cannot open.
 */
async function cmdLink(opts: { url?: string; name?: string }): Promise<void> {
  const baseUrl = opts.url ?? (await ask("Worker URL: "));
  if (!baseUrl) throw new Error("--url is required");

  const deviceName = opts.name ?? hostname();
  const pending = await beginLink(baseUrl, deviceName, currentPlatform());

  const qr = await qrToString(pending.url, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "L",
  });

  console.log(qr);
  console.log(`Scan this, or open the link on a device that is already set up:`);
  console.log(`\n  ${pending.url}\n`);
  console.log(`Or from that device's terminal:`);
  console.log(`\n  clipsync approve ${pending.url}\n`);
  console.log(`Check that it shows the same code:  ${pending.fingerprint}`);
  console.log(`\nWaiting for approval…`);

  let lastShown = -1;
  const { credentials, passphrase } = await awaitApproval(
    baseUrl,
    pending,
    (secondsLeft) => {
      const minutes = Math.ceil(secondsLeft / 60);
      if (minutes !== lastShown) {
        lastShown = minutes;
        console.log(`  …${minutes} minute${minutes === 1 ? "" : "s"} left`);
      }
    },
  );

  await saveConfig({ baseUrl, deviceName, passphrase, ...credentials });
  console.log(`\nLinked "${deviceName}" (${credentials.deviceId}).`);
  console.log(`Credentials written to ${configPath()}.`);
  console.log(`\nNext: clipsync run`);
}

/** Approve a device that ran `clipsync link`. Requires this device's vault. */
async function cmdApprove(target: string | undefined): Promise<void> {
  if (!target) {
    throw new Error("usage: clipsync approve <link-url>");
  }

  const config = await requireConfig();
  const parsed = parseLinkUrl(target);
  if (!parsed) {
    throw new Error(
      "that does not look like a link URL -- paste the whole https://…/link#… line",
    );
  }

  const status = await inspectLink(config.baseUrl, config.token, parsed.linkId);
  const fp = await fingerprint(parsed.publicKey);

  console.log(`\nDevice requesting access:`);
  console.log(`  name        ${status.deviceName}`);
  console.log(`  platform    ${status.platform}`);
  console.log(`  code        ${fp}`);
  console.log(
    `\nApprove only if that code matches the one shown on the other device.`,
  );

  const answer = await ask("Approve? [y/N] ");
  if (!/^y(es)?$/i.test(answer)) {
    console.log("Not approved.");
    return;
  }

  const { deviceName } = await approveLink(
    config.baseUrl,
    config.token,
    parsed.linkId,
    parsed.publicKey,
    resolvePassphrase(config),
  );
  console.log(`Approved "${deviceName}". It can start syncing now.`);
}

async function cmdPairCode(): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const { code, expiresAt } = await api.pairCode();
  const mins = Math.round((expiresAt - Date.now()) / 60000);

  console.log(`\n  ${code}\n`);
  console.log(`Valid for ${mins} minutes, single use. On the other device:`);
  console.log(`  clipsync pair ${code} --url ${config.baseUrl}`);
}

async function cmdRun(opts: {
  pushCurrent?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const config = await requireConfig();
  const daemon = new Daemon(config, {
    pushCurrent: opts.pushCurrent,
    verbose: opts.verbose,
  });

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
}

async function cmdHistory(limit: number): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const keys = await deriveKeys(resolvePassphrase(config), config.kdfSalt);

  const { clips } = await api.listClips(limit);
  if (!clips.length) {
    console.log("No clips yet.");
    return;
  }

  const { devices } = await api.devices();
  const names = new Map(devices.map((d) => [d.id, d.name]));

  for (const clip of clips) {
    let text: string;
    try {
      text = preview(await decryptText(keys, clip.envelope));
    } catch {
      text = "<cannot decrypt — different passphrase>";
    }
    const origin = names.get(clip.deviceId) ?? clip.deviceId;
    console.log(
      `${clip.pinned ? "*" : " "} ${clip.id}  ${relativeTime(clip.createdAt).padStart(8)}  ${origin.padEnd(12)}  ${text}`,
    );
  }
}

async function cmdCopy(id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: clipsync copy <clip-id>");

  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const keys = await deriveKeys(resolvePassphrase(config), config.kdfSalt);

  const clip = await api.getClip(id);
  const text = await decryptText(keys, clip.envelope);
  await (await detectClipboard()).write(text);
  console.log(`Copied ${text.length} chars to the clipboard.`);
}

async function cmdDevices(opts: { revoke?: string }): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);

  if (opts.revoke) {
    await api.revokeDevice(opts.revoke);
    console.log(`Revoked ${opts.revoke}.`);
    return;
  }

  const { devices } = await api.devices();
  for (const device of devices) {
    const marker = device.online ? "online " : "offline";
    const self = device.id === config.deviceId ? " (this device)" : "";
    console.log(
      `${marker}  ${device.name.padEnd(16)} ${device.platform.padEnd(8)} ` +
        `seen ${relativeTime(device.lastSeen).padEnd(9)} ${device.id}${self}`,
    );
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log("Not configured. Run `clipsync login` or `clipsync pair`.");
    return;
  }

  console.log(`config     ${configPath()}`);
  console.log(`worker     ${config.baseUrl}`);
  console.log(`device     ${config.deviceName} (${config.deviceId})`);
  console.log(
    `passphrase ${process.env.CLIPSYNC_PASSPHRASE ? "from CLIPSYNC_PASSPHRASE" : config.passphrase ? "stored in config" : "not set"}`,
  );

  try {
    const clipboard = await detectClipboard();
    console.log(`clipboard  ${clipboard.name}`);
  } catch (err) {
    console.log(`clipboard  unavailable — ${(err as Error).message}`);
  }

  try {
    await new ApiClient(config.baseUrl, config.token).me();
    console.log("worker     reachable, token valid");
  } catch (err) {
    console.log(`worker     ${err instanceof Error ? err.message : err}`);
  }
}

/* -------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      name: { type: "string" },
      revoke: { type: "string" },
      number: { type: "string", short: "n" },
      "push-current": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, arg] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "login":
      return cmdLogin({ url: values.url, name: values.name });
    case "link":
      return cmdLink({ url: values.url, name: values.name });
    case "approve":
      return cmdApprove(arg);
    case "pair":
      return cmdPair(arg, { url: values.url, name: values.name });
    case "pair-code":
      return cmdPairCode();
    case "run":
      return cmdRun({
        pushCurrent: values["push-current"],
        verbose: values.verbose,
      });
    case "history":
      return cmdHistory(Number(values.number) || 20);
    case "copy":
      return cmdCopy(arg);
    case "devices":
      return cmdDevices({ revoke: values.revoke });
    case "status":
      return cmdStatus();
    case "logout":
      await clearConfig();
      console.log("Local credentials removed.");
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main()
  .finally(closePrompts)
  .catch((err: unknown) => {
    if (err instanceof ApiRequestError) {
      console.error(`error: ${err.message} (${err.status} ${err.code})`);
    } else {
      console.error(`error: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 1;
  });
