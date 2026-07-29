/**
 * systemd lifecycle for the `opensession` CLI.
 *
 * The repo's `opensession.service` is a copy of Tella's deployed unit, with
 * that box's user, checkout path and bun path baked in — it is a template
 * here, never a file to install verbatim. `renderUnit()` rewrites the five
 * host-specific directives and leaves every tuning comment (KillMode, the
 * drain window, the IMDS block) intact, because those encode hard-won
 * behaviour that a fresh install wants too.
 *
 * Everything degrades gracefully when systemd is absent (macOS, containers,
 * WSL): the CLI falls back to running the server in the foreground.
 */

import { existsSync } from "fs";
import { userInfo } from "os";
import { join } from "path";
import { ENV_PATH, HOME, REPO_ROOT, SERVICE_NAME, SERVICE_PATH } from "./paths";
import { dim, info, ok, run, runInherit, warn } from "./ui";

export function hasSystemd(): boolean {
  return Boolean(Bun.which("systemctl")) && existsSync("/run/systemd/system");
}

export async function isInstalled(): Promise<boolean> {
  if (!hasSystemd()) return false;
  const { code } = await run(["systemctl", "list-unit-files", `${SERVICE_NAME}.service`]);
  return code === 0 && existsSync(SERVICE_PATH);
}

export async function isActive(): Promise<boolean> {
  if (!hasSystemd()) return false;
  const { stdout } = await run(["systemctl", "is-active", SERVICE_NAME]);
  return stdout === "active";
}

/** Rewrite the repo's unit for this box. Returns the rendered file contents. */
export async function renderUnit(): Promise<string> {
  const template = join(REPO_ROOT, "opensession.service");
  if (!existsSync(template)) {
    throw new Error(`missing unit template at ${template}`);
  }

  const user = userInfo().username;
  const bunPath = Bun.which("bun") ?? join(HOME, ".bun", "bin", "bun");
  const bunDir = bunPath.replace(/\/bun$/, "");

  // PATH must carry bun plus the usual user-local bins; engine subprocesses
  // inherit it, so a too-narrow PATH here shows up much later as "command not
  // found" inside an agent run rather than as a boot failure.
  const path = [
    bunDir,
    join(HOME, ".local", "bin"),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");

  return (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${user}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${REPO_ROOT}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${ENV_PATH}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${bunPath} run opensession.ts`)
    .replace(/^Environment="PATH=.*"$/m, `Environment="PATH=${path}"`);
}

/**
 * Install and enable the unit. Needs root, so it shells out to sudo — which
 * is also why this is opt-in rather than part of the default onboard flow.
 */
export async function install(unitPath: string): Promise<boolean> {
  if (!hasSystemd()) {
    warn("systemd not available on this box — skipping service install");
    return false;
  }

  info(dim(`installing ${unitPath} -> ${SERVICE_PATH} (needs sudo)`));
  for (const cmd of [
    ["sudo", "cp", unitPath, SERVICE_PATH],
    ["sudo", "systemctl", "daemon-reload"],
    ["sudo", "systemctl", "enable", "--now", SERVICE_NAME],
  ]) {
    if ((await runInherit(cmd)) !== 0) {
      warn(`failed: ${cmd.join(" ")}`);
      return false;
    }
  }
  ok("service installed and started");
  return true;
}

export async function control(action: "start" | "stop" | "restart"): Promise<number> {
  if (!hasSystemd() || !(await isInstalled())) {
    warn(`no systemd service installed — run the server directly with ${dim("opensession start --foreground")}`);
    return 1;
  }
  return await runInherit(["sudo", "systemctl", action, SERVICE_NAME]);
}

export async function logs(follow: boolean, lines: number): Promise<number> {
  if (!hasSystemd() || !(await isInstalled())) {
    warn("no systemd service installed — nothing to tail");
    return 1;
  }
  const cmd = ["journalctl", "-u", SERVICE_NAME, "-n", String(lines)];
  if (follow) cmd.push("-f");
  return await runInherit(cmd);
}
