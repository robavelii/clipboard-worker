import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_FOR_GOOD,
  installService,
  launchdPlist,
  restartServiceIfInstalled,
  servicePaths,
  supervise,
  systemdUnit,
  uninstallService,
  windowsTaskXml,
  type Exec,
  type ServicePlatform,
} from "../src/service";

const which = (tool: string) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A command runner that records what it was asked and always succeeds. */
function recorder(output = "") {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { code: 0, output };
  };
  return { calls, exec };
}

const home = () => mkdtempSync(join(tmpdir(), "clipsync-service-"));

describe("service definitions", () => {
  const spaced = ["/home/rob/My Apps/clipsync"];

  it("quote paths with spaces and escape systemd's specifiers", () => {
    const unit = systemdUnit(["/opt/100%/clip$ync"]);
    expect(unit).toContain('ExecStart="/opt/100%%/clip$$ync" "run"');
    expect(systemdUnit(spaced)).toContain('ExecStart="/home/rob/My Apps/clipsync" "run"');
    expect(unit).toContain("RestartForceExitStatus=75");
    expect(unit).toContain("RestartPreventExitStatus=78");
  });

  it.skipIf(!which("systemd-analyze"))("writes a unit systemd accepts", () => {
    const dir = home();
    const program = join(dir, "clip sync");
    writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
    const unit = join(dir, "clipsync.service");
    writeFileSync(unit, systemdUnit([program]));
    // Exits non-zero, with the reason, on any error in the unit.
    execFileSync("systemd-analyze", ["verify", unit], { stdio: "pipe" });
  });

  it.skipIf(!which("python3"))("writes a plist that parses, with the agent's arguments", () => {
    const plist = launchdPlist(["/Users/rob/.local/bin/clip<sync>"], "/Users/rob/Library/Logs/clipsync.log");
    const parsed = JSON.parse(
      execFileSync("python3", ["-c", "import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"], {
        input: plist,
      }).toString(),
    );
    expect(parsed.ProgramArguments).toEqual(["/Users/rob/.local/bin/clip<sync>", "run"]);
    expect(parsed.EnvironmentVariables.CLIPSYNC_SUPERVISOR).toBe("launchd");
    expect(parsed.KeepAlive).toEqual({ SuccessfulExit: false });
  });

  it.skipIf(!which("xmllint"))("writes a task that is well-formed XML and runs the supervisor hidden", () => {
    const task = windowsTaskXml(["C:\\Users\\Rob Smith\\AppData\\Local\\Programs\\clipsync\\clipsync.exe"], "PC\\Rob & co");
    // The declared encoding is UTF-16, which is how install writes it.
    execFileSync("xmllint", ["--noout", "-"], { input: Buffer.from(`\ufeff${task}`, "utf16le") });
    expect(task).toContain("<Command>conhost.exe</Command>");
    expect(task).toContain(
      '<Arguments>--headless &quot;C:\\Users\\Rob Smith\\AppData\\Local\\Programs\\clipsync\\clipsync.exe&quot; supervise</Arguments>',
    );
    expect(task).toContain("<UserId>PC\\Rob &amp; co</UserId>");
    expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });
});

describe.each<[ServicePlatform, RegExp[]]>([
  ["linux", [/^systemctl --user daemon-reload$/, /^systemctl --user enable clipsync.service$/, /^systemctl --user restart clipsync.service$/]],
  ["macos", [/^launchctl bootout gui\/\d+\/clipsync.agent$/, /^launchctl bootstrap gui\/\d+ .*clipsync.agent.plist$/]],
  ["windows", [/^schtasks \/End \/TN ClipSync$/, /^schtasks \/Create \/TN ClipSync \/XML .*task.xml \/F$/, /^schtasks \/Run \/TN ClipSync$/]],
])("installing on %s", (platform, expected) => {
  const env = { LOCALAPPDATA: "", XDG_CONFIG_HOME: "", XDG_BIN_HOME: "", USERNAME: "rob" };

  it("writes the definition and starts it", () => {
    const dir = home();
    const { calls, exec } = recorder();
    const result = installService({ platform, env, home: dir, exec });
    expect(existsSync(result.definition)).toBe(true);
    let at = -1;
    for (const pattern of expected) {
      const next = calls.findIndex((c, i) => i > at && pattern.test(c));
      expect(next, `${pattern} after ${calls[at]}`).toBeGreaterThan(at);
      at = next;
    }
    if (platform === "windows") {
      // schtasks reads task XML as UTF-16, BOM first.
      expect([...readFileSync(result.definition).subarray(0, 2)]).toEqual([0xff, 0xfe]);
    }
  });

  it("does nothing in a dry run", () => {
    const dir = home();
    const { calls, exec } = recorder();
    const result = installService({ platform, env, home: dir, exec, dryRun: true });
    expect(existsSync(result.definition)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("restarts after enrolment only when installed, and uninstalls", () => {
    const dir = home();
    const { calls, exec } = recorder();
    expect(restartServiceIfInstalled({ platform, env, home: dir, exec })).toBe(false);
    expect(calls).toEqual([]);

    installService({ platform, env, home: dir, exec });
    expect(restartServiceIfInstalled({ platform, env, home: dir, exec })).toBe(true);

    const { removed } = uninstallService({ platform, env, home: dir, exec });
    expect(removed).toBe(true);
    expect(existsSync(servicePaths(platform, env, dir).definition)).toBe(false);
  });
});

describe("supervise", () => {
  /** An agent that exits with the next status in its list, one per run. */
  function fakeAgent(statuses: number[]) {
    const dir = home();
    const count = join(dir, "runs");
    const script = join(dir, "agent.cjs");
    writeFileSync(
      script,
      `const fs = require("fs");
       const n = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0;
       fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
       console.log("run " + n + " under " + process.env.CLIPSYNC_SUPERVISOR);
       process.exit(${JSON.stringify(statuses)}[n]);`,
    );
    return { dir, count, command: [process.execPath, script] };
  }

  it("restarts on 75 at once and on a crash after a pause, and stops on 78", async () => {
    const agent = fakeAgent([75, 1, EXIT_FOR_GOOD]);
    const log = join(agent.dir, "clipsync.log");
    const pidFile = join(agent.dir, "supervisor.pid");
    const code = await supervise({ command: agent.command, log, pidFile, restartDelayMs: 50 });
    expect(code).toBe(EXIT_FOR_GOOD);
    expect(readFileSync(agent.count, "utf8")).toBe("3");
    expect(readFileSync(log, "utf8")).toContain("run 2 under clipsync");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("stops when the agent exits cleanly", async () => {
    const agent = fakeAgent([0]);
    expect(await supervise({ command: agent.command, log: join(agent.dir, "log"), restartDelayMs: 50 })).toBe(0);
    expect(readFileSync(agent.count, "utf8")).toBe("1");
  });
});
