/** clipsync — command line entry point. */

import { watchFile } from "node:fs";
import { hostname, platform as osPlatform } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Credentials, Platform } from "@clipsync/protocol";
import { DecryptError } from "@clipsync/crypto";
import { ApiClient, ApiRequestError } from "@clipsync/client";
import {
  approveLink,
  awaitApproval,
  beginLink,
  inspectLink,
  parseLinkUrl,
} from "@clipsync/client/link";
import { createInvite } from "@clipsync/client/invite";
import { reencryptHistory, rekeyVault } from "@clipsync/client/rekey";
import {
  currentKey,
  decryptClip,
  ringKeysFrom,
  ringOf,
  type VaultRing,
} from "@clipsync/client/ring";
import { fingerprint } from "@clipsync/crypto";
import { toString as qrToString } from "qrcode";
import { detectClipboard } from "./clipboard";
import {
  clearConfig,
  configPath,
  ensureDeviceKey,
  freshRing,
  loadConfig,
  requireConfig,
  saveConfig,
  storedRing,
  withRing,
  type AgentConfig,
} from "./config";
import { changePassphrase, unlockVault } from "@clipsync/client/vault";
import { Daemon, log } from "./daemon";
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
  clipsync devices [--revoke <id> [--rekey]]            List or revoke devices
  clipsync rekey [--finish]                             Move to a new vault key (after a revoke)
  clipsync status                                       Show current configuration
  clipsync logout                                       Forget local credentials
`;

/**
 * EX_CONFIG from sysexits.h: the configuration no longer works -- the device
 * was revoked, or the vault re-keyed without it.
 */
const EXIT_REVOKED = 78;

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

/**
 * The account predates passphrase proofs and another device registered a
 * different one first. Worth saying loudly: that device, not this passphrase,
 * can now change the passphrase.
 */
function warnProofConflict(): void {
  console.warn(
    "\nWarning: another device registered a different passphrase for this account\n" +
      "before this one did. It can change the passphrase and this one cannot.\n" +
      "If that was not you, revoke devices you do not recognise (clipsync devices).\n",
  );
}

/**
 * Write a newly enrolled device's config, then register its device key so a
 * re-key reaches it even before `clipsync run` first starts.
 */
async function enrol(
  baseUrl: string,
  deviceName: string,
  creds: Credentials,
  vaultKey: string,
): Promise<void> {
  const { createdAccount: _, ...rest } = creds;
  const config: AgentConfig = withRing(
    { baseUrl, deviceName, ...rest },
    ringOf(vaultKey, creds.keyEpoch ?? 0),
  );
  await saveConfig(config);
  try {
    await ensureDeviceKey(config, new ApiClient(baseUrl, creds.token));
  } catch (err) {
    // `clipsync run` registers it again; not worth failing enrolment over.
    console.warn(
      `note: could not register this device's key yet (${err instanceof Error ? err.message : err})`,
    );
  }
}

/** Progress for re-encryption, on one rewritten line. */
function progress(count: number): void {
  process.stdout.write(`\r  re-encrypted ${count} clip${count === 1 ? "" : "s"}`);
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
  const { vaultKey, migrated, proofConflict } = await unlockVault(
    api,
    passphrase,
    creds.kdfSalt,
    creds.wrappedVaultKey,
    creds.createdAccount ?? false,
  );

  await enrol(baseUrl, deviceName, creds, vaultKey);
  if (migrated && !creds.createdAccount) {
    console.log("Upgraded this account to a wrapped vault key.");
  }
  if (proofConflict) warnProofConflict();
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

  await enrol(baseUrl, deviceName, creds, vaultKey);
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

  await enrol(baseUrl, deviceName, credentials, vaultKey);
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
  const { ring } = await freshRing(config, api);

  const invite = await createInvite(api, config.baseUrl, currentKey(ring));

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
    currentKey((await freshRing(config, api)).ring),
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
    // A distinct status, so the service unit can tell "revoked" from a crash
    // and not restart into the same 401 forever (RestartPreventExitStatus).
    onRevoked: () => process.exit(EXIT_REVOKED),
    onStranded: () => process.exit(EXIT_REVOKED),
  });

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await daemon.start();
  if (process.env.INVOCATION_ID) restartOnRebuild(daemon);
}

/** Exit status systemd's Restart=on-failure acts on (EX_TEMPFAIL). */
const EXIT_RESTART = 75;

/**
 * Hand over to a freshly built agent when this bundle is replaced on disk.
 *
 * The service runs the bundle straight from the checkout, so without this a
 * rebuild changes nothing until someone remembers to restart it -- and a
 * daemon quietly running last week's code is indistinguishable from one
 * that is up to date. Only under systemd (INVOCATION_ID is set for every
 * unit it starts), where exiting means being restarted rather than stopped.
 */
function restartOnRebuild(daemon: Daemon): void {
  const bundle = fileURLToPath(import.meta.url);
  watchFile(bundle, { interval: 5_000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs || curr.size === 0) return;
    log(`new build on disk -- restarting to pick it up (was ${__CLIPSYNC_BUILD__})`);
    daemon.stop();
    process.exit(EXIT_RESTART);
  });
}

async function cmdHistory(limit: number, full = false): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);
  const keys = await ringKeysFrom((await freshRing(config, api)).ring, config.kdfSalt);

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
      text = await decryptClip(keys, clip);
    } catch {
      text = null;
    }
    const origin = names.get(clip.deviceId) ?? clip.deviceId;
    const head = `${clip.pinned ? "*" : " "} ${clip.id}  ${relativeTime(clip.createdAt).padStart(8)}  ${origin.padEnd(12)}`;
    if (text === null) {
      console.log(
        `${head}  <cannot decrypt — ${
          keys.byEpoch.has(clip.keyEpoch) ? "different passphrase" : `no key for epoch ${clip.keyEpoch}`
        }>`,
      );
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
  const keys = await ringKeysFrom((await freshRing(config, api)).ring, config.kdfSalt);

  const clip = await api.getClip(id);
  const text = await decryptClip(keys, clip);
  await (await detectClipboard()).write(text);
  console.log(`Copied ${text.length} chars to the clipboard.`);
}

async function cmdDevices(opts: { revoke?: string; rekey?: boolean }): Promise<void> {
  const config = await requireConfig();
  const api = new ApiClient(config.baseUrl, config.token);

  if (opts.revoke) {
    await api.revokeDevice(opts.revoke);
    console.log(`Revoked ${opts.revoke}.`);
    if (opts.rekey) {
      console.log();
      return cmdRekey({});
    }
    console.log(
      "It can no longer sync, but it still holds the vault key. To make sure it\n" +
        "can never read another clip: clipsync rekey",
    );
    return;
  }

  const { devices } = await api.devices();
  for (const device of devices) {
    const marker = device.online ? "online " : "offline";
    const self = device.id === config.deviceId ? " (this device)" : "";
    // A device with no key registered would be left out of a re-key.
    const keyless = device.publicKey ? "" : " (no device key)";
    console.log(
      `${marker}  ${device.name.padEnd(16)} ${device.platform.padEnd(8)} ` +
        `seen ${relativeTime(device.lastSeen).padEnd(9)} ${device.id}${self}${keyless}`,
    );
  }
}

/**
 * Move the account to a new vault key and re-encrypt history under it.
 *
 * Revoking a device stops its token, but the vault key it was given still
 * opens every clip. After a re-key it opens none written since, and none
 * already re-encrypted. Active devices get the new key sealed to their device
 * key and switch over by themselves; ones without a device key are listed
 * and must be enrolled again.
 *
 * `--finish` resumes re-encryption if it was interrupted, and needs no
 * passphrase: it only moves clips between keys this device already holds.
 */
async function cmdRekey(opts: { finish?: boolean }): Promise<void> {
  const loaded = await requireConfig();
  const api = new ApiClient(loaded.baseUrl, loaded.token);
  const { config, ring } = await freshRing(loaded, api);
  const save = async (next: VaultRing) => {
    if (storedRing(config)) await saveConfig(withRing(config, next));
  };

  if (opts.finish) {
    const { reencrypted, unreadable } = await reencryptHistory(
      api,
      ring,
      config.kdfSalt,
      progress,
    );
    if (reencrypted) console.log();
    console.log(`Re-encrypted ${reencrypted} clip${reencrypted === 1 ? "" : "s"}.`);
    if (unreadable) {
      console.log(`${unreadable} are under a key this device does not hold; left as they are.`);
    }
    return;
  }

  console.log(
    "Re-keying moves every device to a new vault key and re-encrypts your\n" +
      "history under it. Revoked devices get nothing.\n",
  );
  const passphrase =
    process.env.CLIPSYNC_PASSPHRASE ?? (await askSecret("Passphrase: "));

  let result;
  try {
    result = await rekeyVault(api, config.kdfSalt, passphrase, ring, {
      onRotated: save,
      onProgress: progress,
    });
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new Error("that is not the passphrase -- nothing was changed");
    }
    throw err;
  }
  if (result.reencrypted) console.log();

  console.log(`\nVault re-keyed (epoch ${result.epoch}).`);
  console.log(
    `Re-encrypted ${result.reencrypted} clip${result.reencrypted === 1 ? "" : "s"}.`,
  );
  if (result.unreadable) {
    console.log(
      `${result.unreadable} are under a key this device does not hold. Run\n` +
        "`clipsync rekey --finish` on a device that can read them.",
    );
  }
  if (result.unsealed.length) {
    console.log("\nThese devices have no device key, so they did not get the new one.");
    console.log("They can read old clips but not new ones; enrol them again:");
    for (const device of result.unsealed) {
      console.log(`  ${device.name} (${device.id})`);
    }
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

  console.log(
    "Changing the passphrase re-wraps your vault key.\n" +
      "Your clips are not re-encrypted and your other devices keep working.\n",
  );

  // The server replaces the wrapped key only with proof of the current
  // passphrase, so holding the vault key is not enough to change it.
  const current =
    process.env.CLIPSYNC_PASSPHRASE ?? (await askSecret("Current passphrase: "));
  const next = await askNewPassphrase();
  try {
    await changePassphrase(api, config.kdfSalt, current, next);
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new Error("that is not the current passphrase -- nothing was changed");
    }
    throw err;
  }

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

  console.log(`build      ${__CLIPSYNC_BUILD__}`);
  console.log(`config     ${configPath()}`);
  console.log(`worker     ${config.baseUrl}`);
  console.log(`device     ${config.deviceName} (${config.deviceId})`);
  console.log(
    `vault key  ${
      config.vaultKey
        ? `stored in config, epoch ${config.keyEpoch ?? 0}`
        : config.passphrase
          ? "will upgrade from the stored passphrase on next use"
          : process.env.CLIPSYNC_PASSPHRASE
            ? "unwrapped from CLIPSYNC_PASSPHRASE at startup"
            : "missing"
    }`,
  );

  console.log(
    `device key ${
      config.deviceKey
        ? "stored in config"
        : storedRing(config)
          ? "not yet created -- `clipsync run` creates it"
          : "none (CLIPSYNC_PASSPHRASE mode picks up re-keys through the passphrase)"
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
      rekey: { type: "boolean" },
      finish: { type: "boolean" },
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
      return cmdDevices({ revoke: values.revoke, rekey: values.rekey });
    case "rekey":
      return cmdRekey({ finish: values.finish });
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
