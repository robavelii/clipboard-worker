/**
 * Running the agent as a background service that starts with the desktop
 * session: `clipsync install` and `clipsync uninstall` (decisions §32).
 *
 *   Linux    a systemd user unit, clipsync.service
 *   macOS    a launchd agent, clipsync.agent
 *   Windows  a Task Scheduler task, ClipSync, run at logon
 *
 * All three must honour the agent's exit codes: 75 means "restart me onto
 * the new build", 78 means "stop for good" (revoked, re-keyed out, or not
 * enrolled). systemd says so in the unit. launchd cannot exclude one status,
 * so the agent exits 0 instead of 78 under it. Task Scheduler cannot tell
 * exit codes apart at all, so the Windows task runs `clipsync supervise`,
 * which restarts the agent by the same rules (see `supervise`).
 *
 * A standalone binary installs a copy of itself to a fixed place first, so
 * the service does not point into a Downloads folder. Run from a checkout,
 * the service runs node and the bundle where they are, as
 * scripts/install-agent.sh always has.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isSea, runningFile, selfCommand } from "./self";

export type ServicePlatform = "linux" | "macos" | "windows";

export const SYSTEMD_UNIT = "clipsync.service";
export const LAUNCHD_LABEL = "clipsync.agent";
export const WINDOWS_TASK = "ClipSync";

/** Exit statuses the agent and every supervisor agree on. */
export const EXIT_RESTART = 75;
export const EXIT_FOR_GOOD = 78;

export function servicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  throw new Error(`no background service for ${platform} -- run \`clipsync run\` yourself`);
}

interface Paths {
  /** Where a standalone binary copies itself. */
  binary: string;
  /** The unit, plist or task definition. */
  definition: string;
  /** The agent's log, where the service writes one (journald keeps Linux's). */
  log: string | null;
}

export function servicePaths(
  platform: ServicePlatform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Paths {
  switch (platform) {
    case "linux":
      return {
        binary: join(env.XDG_BIN_HOME || join(home, ".local", "bin"), "clipsync"),
        definition: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", SYSTEMD_UNIT),
        log: null,
      };
    case "macos":
      return {
        binary: join(env.XDG_BIN_HOME || join(home, ".local", "bin"), "clipsync"),
        definition: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        log: join(home, "Library", "Logs", "clipsync.log"),
      };
    case "windows": {
      const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
      return {
        binary: join(local, "Programs", "clipsync", "clipsync.exe"),
        definition: join(local, "clipsync", "task.xml"),
        log: join(local, "clipsync", "clipsync.log"),
      };
    }
  }
}

/* ----------------------------- definitions ----------------------------- */

/** One systemd ExecStart word: quoted, with its specifiers escaped. */
function systemdWord(word: string): string {
  const escaped = word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

export function systemdUnit(command: string[]): string {
  return `[Unit]
Description=ClipSync clipboard agent
Documentation=https://github.com/robavelii/clipboard-worker
# The clipboard belongs to the graphical session, so the agent is useless
# without one and should stop when it ends.
After=graphical-session.target
PartOf=graphical-session.target
# Never stop retrying: a laptop that wakes to a dead network should reconnect
# on its own rather than needing a manual restart.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${[...command, "run"].map(systemdWord).join(" ")}
Restart=on-failure
RestartSec=5
# The agent exits ${EXIT_RESTART} when its bundle or binary is replaced, to be
# restarted onto the new code. That is a handover, not a failure.
SuccessExitStatus=${EXIT_RESTART}
RestartForceExitStatus=${EXIT_RESTART}
# The agent exits ${EXIT_FOR_GOOD} when its device has been revoked, the vault
# re-keyed without a copy for it, or it was never enrolled. Restarting would
# only retry what can never work.
RestartPreventExitStatus=${EXIT_FOR_GOOD}

[Install]
WantedBy=graphical-session.target
`;
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * KeepAlive restarts any exit but a clean one. launchd cannot be told to
 * leave one failure status alone, so CLIPSYNC_SUPERVISOR tells the agent to
 * exit 0 where it would exit 78 -- and it still exits 75 onto a new build,
 * which launchd restarts like any failure. LimitLoadToSessionType: the
 * clipboard belongs to the logged-in desktop (Aqua) session.
 */
export function launchdPlist(command: string[], log: string): string {
  const args = [...command, "run"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLIPSYNC_SUPERVISOR</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** A Windows command line from words: each quoted, since paths hold spaces. */
function windowsArgs(words: string[]): string {
  return words.map((w) => (/[\s"]/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w)).join(" ");
}

/**
 * A logon task for this user, with no time limit, one instance, and no
 * battery rules. It runs `clipsync supervise` through `conhost --headless`:
 * a console program started by Task Scheduler otherwise opens a console
 * window for as long as it runs.
 */
export function windowsTaskXml(command: string[], user: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ClipSync clipboard agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xml(windowsArgs(["--headless", ...command, "supervise"]))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/* ------------------------------- running -------------------------------- */

export interface Exec {
  (cmd: string, args: string[]): { code: number; output: string };
}

const realExec: Exec = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (res.error) return { code: -1, output: res.error.message };
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
};

function must(exec: Exec, cmd: string, args: string[]): string {
  const { code, output } = exec(cmd, args);
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  return output;
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

function windowsUser(env: NodeJS.ProcessEnv): string {
  const name = env.USERNAME || userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
}

/**
 * Put a copy of this binary where the service will run it. Written beside
 * the target and renamed over it, never overwritten in place: Linux refuses
 * to write a running executable ("Text file busy"), and Windows refuses to
 * replace one but lets it be renamed out of the way.
 */
function placeBinary(target: string): void {
  const source = runningFile();
  if (resolve(source) === resolve(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  const fresh = `${target}.new`;
  copyFileSync(source, fresh);
  chmodSync(fresh, 0o755);
  try {
    renameSync(fresh, target);
  } catch (err) {
    if (process.platform !== "win32" || !existsSync(target)) throw err;
    const aside = `${target}.old`;
    rmSync(aside, { force: true });
    renameSync(target, aside);
    renameSync(fresh, target);
  }
}

export interface InstallResult {
  platform: ServicePlatform;
  definition: string;
  /** The program the service starts. */
  command: string[];
  log: string | null;
  /** How to follow the logs, stop it, and remove it. */
  hints: string[];
}

export interface ServiceOptions {
  platform?: ServicePlatform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exec?: Exec;
  /** Write nothing and start nothing; report what would be done. */
  dryRun?: boolean;
}

/** Install (or reinstall) the service and start it on the current build. */
export function installService(opts: ServiceOptions = {}): InstallResult {
  const platform = opts.platform ?? servicePlatform();
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? realExec;
  const paths = servicePaths(platform, env, opts.home);

  // Before touching anything: without a user session (WSL without systemd,
  // a container, a bare SSH login) there is nothing to install into.
  if (platform === "linux" && !opts.dryRun && exec("systemctl", ["--user", "show-environment"]).code !== 0) {
    throw new Error(
      "systemd's user session is not reachable here, so there is no service to install -- " +
        "start `clipsync run` from your desktop's autostart instead",
    );
  }

  const command = isSea() ? [paths.binary] : selfCommand();
  if (isSea() && !opts.dryRun) placeBinary(paths.binary);

  let definition: string;
  let hints: string[];
  switch (platform) {
    case "linux":
      definition = systemdUnit(command);
      hints = [
        "Logs:    journalctl --user -u clipsync -f",
        "Stop:    systemctl --user stop clipsync",
      ];
      break;
    case "macos":
      definition = launchdPlist(command, paths.log!);
      hints = [
        `Logs:    tail -f ${paths.log}`,
        `Stop:    launchctl bootout gui/${uid()}/${LAUNCHD_LABEL}`,
      ];
      break;
    case "windows":
      definition = windowsTaskXml(command, windowsUser(env));
      hints = [
        `Logs:    Get-Content -Wait "${paths.log}"`,
        `Stop:    schtasks /End /TN ${WINDOWS_TASK}`,
      ];
      break;
  }
  hints.push("Remove:  clipsync uninstall");

  const result = { platform, definition: paths.definition, command, log: paths.log, hints };
  if (opts.dryRun) return result;

  mkdirSync(dirname(paths.definition), { recursive: true });
  switch (platform) {
    case "linux":
      writeFileSync(paths.definition, definition);
      // The display the clipboard lives on is set by the graphical session,
      // not by systemd, so the service is handed it.
      exec("systemctl", ["--user", "import-environment", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]);
      must(exec, "systemctl", ["--user", "daemon-reload"]);
      must(exec, "systemctl", ["--user", "enable", SYSTEMD_UNIT]);
      // restart, not start: one already running would keep its old code.
      must(exec, "systemctl", ["--user", "restart", SYSTEMD_UNIT]);
      break;
    case "macos":
      mkdirSync(dirname(paths.log!), { recursive: true });
      writeFileSync(paths.definition, definition);
      // bootout then bootstrap, not kickstart alone: a plist that changed
      // since it was loaded is only re-read on load.
      exec("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      must(exec, "launchctl", ["bootstrap", `gui/${uid()}`, paths.definition]);
      break;
    case "windows":
      // schtasks reads task XML as UTF-16.
      writeFileSync(paths.definition, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(definition, "utf16le")]));
      stopWindows(exec, paths);
      must(exec, "schtasks", ["/Create", "/TN", WINDOWS_TASK, "/XML", paths.definition, "/F"]);
      must(exec, "schtasks", ["/Run", "/TN", WINDOWS_TASK]);
      break;
  }
  return result;
}

/** Stop the Windows task and the supervisor it started, if either runs. */
function stopWindows(exec: Exec, paths: Paths): void {
  exec("schtasks", ["/End", "/TN", WINDOWS_TASK]);
  // Ending the task ends conhost, which may leave the supervisor it
  // started; the supervisor's own pid file finds it. The agent under it
  // exits when the supervisor's pipe closes.
  const pidFile = supervisorPidFile(paths);
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (pid > 0) process.kill(pid);
  } catch {
    // Not running, or already gone.
  }
  rmSync(pidFile, { force: true });
}

const supervisorPidFile = (paths: Paths) => join(dirname(paths.log ?? paths.definition), "supervisor.pid");

/** Stop and remove the service. The binary and credentials stay. */
export function uninstallService(opts: ServiceOptions = {}): { removed: boolean; binary: string | null } {
  const platform = opts.platform ?? servicePlatform();
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? realExec;
  const paths = servicePaths(platform, env, opts.home);
  const removed = existsSync(paths.definition);

  switch (platform) {
    case "linux":
      exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      rmSync(paths.definition, { force: true });
      exec("systemctl", ["--user", "daemon-reload"]);
      break;
    case "macos":
      exec("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      rmSync(paths.definition, { force: true });
      break;
    case "windows":
      stopWindows(exec, paths);
      exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
      rmSync(paths.definition, { force: true });
      break;
  }
  return { removed, binary: existsSync(paths.binary) ? paths.binary : null };
}

/** One line on the service, for `clipsync status`; null when none is installed. */
export function serviceStatus(opts: ServiceOptions = {}): string | null {
  const platform = opts.platform ?? servicePlatform();
  const exec = opts.exec ?? realExec;
  const paths = servicePaths(platform, opts.env ?? process.env, opts.home);
  if (!existsSync(paths.definition)) return null;
  switch (platform) {
    case "linux": {
      const { output } = exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
      return `systemd user unit ${SYSTEMD_UNIT}, ${output || "state unknown"}`;
    }
    case "macos": {
      const { code } = exec("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`]);
      return `launchd agent ${LAUNCHD_LABEL}, ${code === 0 ? "loaded" : "not loaded"}`;
    }
    case "windows": {
      const { output } = exec("schtasks", ["/Query", "/TN", WINDOWS_TASK, "/FO", "LIST"]);
      const state = /^Status:\s*(.+)$/m.exec(output)?.[1]?.trim();
      return `scheduled task ${WINDOWS_TASK}, ${state ?? "state unknown"}`;
    }
  }
}

/**
 * After enrolling: restart an installed service so it runs with the new
 * credentials. An agent started before enrolment exited for good, and would
 * otherwise stay stopped until the next login.
 */
export function restartServiceIfInstalled(opts: ServiceOptions = {}): boolean {
  let platform: ServicePlatform;
  try {
    platform = opts.platform ?? servicePlatform();
  } catch {
    return false;
  }
  const exec = opts.exec ?? realExec;
  const paths = servicePaths(platform, opts.env ?? process.env, opts.home);
  if (!existsSync(paths.definition)) return false;
  switch (platform) {
    case "linux":
      return exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]).code === 0;
    case "macos":
      return exec("launchctl", ["kickstart", "-k", `gui/${uid()}/${LAUNCHD_LABEL}`]).code === 0;
    case "windows":
      stopWindows(exec, paths);
      return exec("schtasks", ["/Run", "/TN", WINDOWS_TASK]).code === 0;
  }
}

/* ------------------------------ supervising ----------------------------- */

/** Logs over this size are moved aside when the supervisor starts one. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface SuperviseOptions {
  /** The program and arguments that run the agent. */
  command: string[];
  log: string;
  pidFile?: string;
  restartDelayMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the agent and restart it the way systemd's unit would, for Windows,
 * where Task Scheduler cannot tell one exit status from another:
 *
 *   75  restart at once, onto the replaced binary
 *   78  stop for good: revoked, re-keyed out, or not enrolled
 *   0   stop: the agent was asked to
 *   any other status, restart after a pause
 *
 * The agent's output goes to the log file. The agent runs with its stdin
 * piped from here and exits when that pipe closes, so killing the supervisor
 * cannot leave an orphan syncing on its own.
 */
export async function supervise(opts: SuperviseOptions): Promise<number> {
  const [cmd, ...args] = opts.command as [string, ...string[]];
  const delay = opts.restartDelayMs ?? 5_000;
  mkdirSync(dirname(opts.log), { recursive: true });
  if (opts.pidFile) writeFileSync(opts.pidFile, String(process.pid));

  for (;;) {
    try {
      if (statSync(opts.log).size > MAX_LOG_BYTES) renameSync(opts.log, `${opts.log}.1`);
    } catch {
      // No log yet.
    }
    const out = openSync(opts.log, "a");
    const child = spawn(cmd, args, {
      stdio: ["pipe", out, out],
      env: { ...(opts.env ?? process.env), CLIPSYNC_SUPERVISOR: "clipsync" },
      windowsHide: true,
    });
    const code = await new Promise<number>((done) => {
      child.on("error", () => done(-1));
      child.on("exit", (status) => done(status ?? -1));
    });
    if (code === EXIT_FOR_GOOD || code === 0) {
      if (opts.pidFile) rmSync(opts.pidFile, { force: true });
      return code;
    }
    if (code !== EXIT_RESTART) await new Promise((r) => setTimeout(r, delay));
  }
}

/** Where `clipsync supervise` logs and keeps its pid, for the Windows task. */
export function supervisorPaths(opts: ServiceOptions = {}): { log: string; pidFile: string } {
  const paths = servicePaths(opts.platform ?? servicePlatform(), opts.env ?? process.env, opts.home);
  const log = paths.log ?? join(dirname(paths.definition), "clipsync.log");
  return { log, pidFile: supervisorPidFile(paths) };
}
