import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scripts = join(import.meta.dirname, "..", "..", "..", "scripts");

const has = (tool: string) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// The Worker serves these (apps/worker/src/routes/install.ts). A syntax
// error in one would only surface on someone's machine, mid-install.
describe("installer scripts", () => {
  it.each(["sh", "dash", "bash"].filter(has))("install.sh parses under %s", (shell) => {
    execFileSync(shell, ["-n", join(scripts, "install.sh")]);
  });

  it.skipIf(!has("pwsh"))("install.ps1 parses under PowerShell", () => {
    // The path goes through the environment: arguments after -Command are
    // joined into the command, not passed as $args.
    const check =
      "$e = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:INSTALL_PS1, [ref]$null, [ref]$e) | Out-Null; " +
      'if ($e) { $e | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }';
    const run = spawnSync("pwsh", ["-NoProfile", "-Command", check], {
      encoding: "utf8",
      env: { ...process.env, INSTALL_PS1: join(scripts, "install.ps1") },
    });
    expect(run.stdout + run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("keep both placeholders the Worker fills in", () => {
    for (const name of ["install.sh", "install.ps1"]) {
      const text = readFileSync(join(scripts, name), "utf8");
      expect(text, name).toContain("__CLIPSYNC_URL__");
      expect(text, name).toContain("__CLIPSYNC_REPO__");
    }
  });
});
