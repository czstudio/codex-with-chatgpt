import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsInstaller = path.join(projectRoot, "scripts", "install-extension-bridge.ps1");

describe("extension bridge installer paths", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    while (temporaryRoots.length > 0) {
      cleanup(temporaryRoots.pop()!);
    }
  });

  it("keeps the macOS CLI path anchored to the installer when cwd changes", () => {
    const workspace = makeTmpDir("installer-workspace");
    const home = makeTmpDir("installer-home");
    const state = makeTmpDir("installer-state");
    const fakeBin = makeTmpDir("installer-bin");
    const launchctlLog = path.join(state, "launchctl.log");
    temporaryRoots.push(workspace, home, state, fakeBin);

    const fakeLaunchctl = path.join(fakeBin, "launchctl");
    fs.writeFileSync(fakeLaunchctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_LAUNCHCTL_LOG\"\n");
    fs.chmodSync(fakeLaunchctl, 0o755);

    execFileSync("/bin/sh", ["./scripts/install-extension-bridge-macos.sh", workspace], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: home,
        C2C_STATE_DIR: state,
        FAKE_LAUNCHCTL_LOG: launchctlLog,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "pipe",
    });

    const plist = path.join(home, "Library", "LaunchAgents", "com.codex.c2c.extension-bridge.plist");
    const contents = fs.readFileSync(plist, "utf8");
    expect(contents).toContain(`<string>${path.join(projectRoot, "dist", "cli", "index.js")}</string>`);
    expect(contents).not.toContain(`<string>${path.join(workspace, "dist", "cli", "index.js")}</string>`);
    expect(fs.readFileSync(launchctlLog, "utf8")).toContain("bootstrap");
  });

  it("resolves the Windows package root from an absolute script root", () => {
    const contents = fs.readFileSync(windowsInstaller, "utf8");
    expect(contents).toContain('$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path');
    expect(contents).toContain('$packageRoot = Split-Path -Parent $scriptRoot');
    expect(contents).toContain('$cliPath = Join-Path $packageRoot "dist\\cli\\index.js"');
  });
});
