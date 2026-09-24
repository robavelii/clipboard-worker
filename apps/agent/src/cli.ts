/** clipsync — command line entry point. */

import { hostname, platform as osPlatform } from "node:os";
import { parseArgs } from "node:util";
import type { Platform } from "@clipsync/protocol";
import { decryptText } from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import {
  approveLink,
  awaitApproval,
  beginLink,
  inspectLink,
  parseLinkUrl,
} from "@clipsync/client/link";
import { createInvite } from "@clipsync/client/invite";
import { fingerprint } from "@clipsync/crypto";
import { toString as qrToString } from "qrcode";
import { detectClipboard } from "./clipboard";
import {
  clearConfig,
  configPath,
  loadConfig,
  requireConfig,
  resolveVaultKey,
  resolveVaultKeys,
  saveConfig,
} from "./config";
import { changePassphrase, unlockVault } from "@clipsync/client/vault";
import { Daemon } from "./daemon";
import { ask, askNewPassphrase, askSecret, closePrompts } from "./prompt";

const USAGE = `clipsync — encrypted clipboard sync

Usage
  clipsync login --url <worker-url> [--name <device>]   Create the account, enrol this device
  clipsync link --url <url> [--name <device>]           Join by QR -- no passphrase typing
  clipsync invite                                       Show a QR for a phone to scan
  clipsync approve <link-url>                           Approve a device that ran 'clipsync link'
  clipsync pair <code> --url <url> [--name <device>]    Join using a pairing code (manual)
  clipsync pair-code                                    Mint a code for another device
  clipsync run [--push-current] [--verbose]             Watch the clipboard and sync
  clipsync history [-n <count>] [--full]                Show recent clips (--full: untruncated)
  clipsync copy <clip-id>                               Copy a clip to this clipboard
  clipsync passphrase                                   Change the passphrase
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

  const api = new ApiClient(baseUrl, creds.token);
  const { vaultKey, migrated } = await unlockVault(
    api,
    passphrase,
    creds.kdfSalt,
    creds.wrappedVaultKey,
    creds.createdAccount ?? false,
  );

  await saveConfig({ baseUrl, deviceName, vaultKey, ...creds });
  if (migrated && !creds.createdAccount) {
    console.log("Upgraded this account to a wrapped vault key.");
  }
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

  const api = new ApiClient(baseUrl, creds.token);

  // A wrong passphrase now fails here, loudly, instead of silently producing
  // a history of undecryptable rows.
  let vaultKey: string;
  try {
    ({ vaultKey } = await unlockVault(
      api,
      passphrase,
      creds.kdfSalt,
      creds.wrappedVaultKey,
    ));
  } catch {
    throw new Error(
      "that passphrase does not unlock this account -- re-run `clipsync pair` with the right one",
    );
  }

  await saveConfig({ baseUrl, deviceName, vaultKey, ...creds });
  console.log(`Paired "${deviceName}" (${creds.deviceId}).`);
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
  const { credentials, vaultKey } = await awaitApproval(
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

  await saveConfig({ baseUrl, deviceName, vaultKey, ...credentials });
  console.log(`\nLinked "${deviceName}" (${credentials.deviceId}).`);
  console.log(`This device holds the vault key, not your passphrase.`);
  console.log(`Credentials written to ${configPath()}.`);
  console.log(`\nNext: clipsync run`);
}

/**
 * Show a QR that enrols whatever scans it.
 *
 * The reverse of `clipsync link`: here *this* device displays the code and the
 * joining device reads it. That suits anything with a camera and no terminal,
 * which is every phone.
 *
 * The QR carries a one-time secret, and the vault key is sealed under it
 * before it ever reaches the server -- so there is no fingerprint to compare.
 * The flip side is that the code on screen is the credential until it expires
 * or is scanned, which is why it lasts five minutes and works once.
 */
async function cmdInvite(): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const vaultKey = await resolveVaultKey(config, api);

  const invite = await createInvite(api, config.baseUrl, vaultKey);

  console.log(
    await qrToString(invite.url, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    }),
  );

  const minutes = Math.round((invite.expiresAt - Date.now()) / 60000);
  console.log(`Scan this with your phone's camera.`);
  console.log(`\n  ${invite.url}\n`);
  console.log(
    `Valid for ${minutes} minutes, one scan. Nothing else to type -- the phone\n` +
      `gets the key from the code itself, not from the server.`,
  );
}

/** Approve a device that ran `clipsync link`. Requires this device's vault. */
async function cmdApprove(target: string | undefined): Promise<void> {
  if (!target) {
    throw new Error("usage: clipsync approve <link-url>");
  }

  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
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
    await resolveVaultKey(config, api),
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

async function cmdHistory(limit: number, full = false): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const keys = await resolveVaultKeys(config, api);

  const { clips } = await api.listClips(limit);
  if (!clips.length) {
    console.log("No clips yet.");
    return;
  }

  const { devices } = await api.devices();
  const names = new Map(devices.map((d) => [d.id, d.name]));

  for (const clip of clips) {
    let text: string | null;
    try {
      text = await decryptText(keys, clip.envelope);
    } catch {
      text = null;
    }
    const origin = names.get(clip.deviceId) ?? clip.deviceId;
    const head = `${clip.pinned ? "*" : " "} ${clip.id}  ${relativeTime(clip.createdAt).padStart(8)}  ${origin.padEnd(12)}`;
    if (text === null) {
      console.log(`${head}  <cannot decrypt — different passphrase>`);
    } else if (full) {
      // The whole clip on its own lines, so long links stay intact and can be
      // selected straight from the terminal.
      console.log(`${head}\n${text.replace(/^/gm, "    ")}\n`);
    } else {
      // Use whatever the terminal has left after the header, not a fixed 64.
      const width = Math.max(32, (process.stdout.columns || 120) - head.length - 2);
      console.log(`${head}  ${preview(text, width)}`);
    }
  }
}

async function cmdCopy(id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: clipsync copy <clip-id>");

  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const keys = await resolveVaultKeys(config, api);

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

/**
 * Change the passphrase.
 *
 * Re-wraps the vault key. No clip is re-encrypted and no other device has to
 * do anything -- they all hold the vault key, not the passphrase.
 */
async function cmdPassphrase(): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const vaultKey = await resolveVaultKey(config, api);

  console.log(
    "Changing the passphrase re-wraps your vault key.\n" +
      "Your clips are not re-encrypted and your other devices keep working.\n",
  );

  const next = await askNewPassphrase();
  await changePassphrase(api, vaultKey, config.kdfSalt, next);

  console.log("\nPassphrase changed.");
  console.log(
    "Use the new one anywhere you unlock with a passphrase — the web UI, or a\n" +
      "device that sets CLIPSYNC_PASSPHRASE.",
  );
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
    `vault key  ${
      config.vaultKey
        ? "stored in config"
        : config.passphrase
          ? "will upgrade from the stored passphrase on next use"
          : process.env.CLIPSYNC_PASSPHRASE
            ? "unwrapped from CLIPSYNC_PASSPHRASE at startup"
            : "missing"
    }`,
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
      full: { type: "boolean", short: "f" },
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
    case "invite":
      return cmdInvite();
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
      return cmdHistory(Number(values.number) || 20, values.full);
    case "copy":
      return cmdCopy(arg);
    case "passphrase":
      return cmdPassphrase();
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
