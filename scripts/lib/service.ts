/**
 * Service lifecycle for the `opensession` CLI, across systemd and launchd.
 *
 * Linux (systemd): the repo's `opensession.service` is a copy of Tella's
 * deployed unit, with that box's user, checkout path and bun path baked in —
 * it is a template here, never a file to install verbatim. `renderUnit()`
 * rewrites the five host-specific directives and leaves every tuning comment
 * (KillMode, the drain window, the IMDS block) intact, because those encode
 * hard-won behaviour that a fresh install wants too. Installing it needs root.
 *
 * macOS (launchd): a per-user LaunchAgent, which needs no root at all. launchd
 * has no equivalent of systemd's EnvironmentFile, so the agent execs through a
 * login shell that sources `~/.opensession.env` first — otherwise none of the
 * integration flags or secrets would reach the server.
 *
 * Anywhere else, everything degrades to "no supervisor" and the CLI runs the
 * server in the foreground.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { userInfo } from "os";
import { join } from "path";
import {
  ENV_PATH,
  EXECUTOR_SERVICE_NAME,
  EXECUTOR_SERVICE_PATH,
  EXECUTOR_TOKEN_PATH,
  HOME,
  OPENSESSION_HOME,
  REPO_ROOT,
  SERVICE_NAME,
  SERVICE_PATH,
} from "./paths";
import { dim, info, ok, run, runInherit, warn } from "./ui";

export type Supervisor = "systemd" | "launchd" | "none";

export const LAUNCHD_LABEL = "dev.opensession.server";
export const LAUNCHD_PLIST = join(HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const LOG_DIR = join(OPENSESSION_HOME, "logs");
const RUN_HOST_HELPER = "/usr/local/libexec/opensession-run-host";

function envFileValue(name: string): string | undefined {
  if (!existsSync(ENV_PATH)) return undefined;
  const prefix = `${name}=`;
  const raw = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .findLast((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  if (!raw) return undefined;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function runHostsRoot(): string {
  const sessionsDir =
    process.env.OPENSESSION_SESSIONS_DIR ||
    envFileValue("OPENSESSION_SESSIONS_DIR") ||
    ((process.env.OPENSESSION_STATE_DIR || envFileValue("OPENSESSION_STATE_DIR"))
      ? join(
          process.env.OPENSESSION_STATE_DIR || envFileValue("OPENSESSION_STATE_DIR")!,
          ".opensession-sessions",
        )
      : join(HOME, ".opensession-sessions"));
  return join(sessionsDir, "run-hosts");
}

export function supervisor(): Supervisor {
  if (process.platform === "darwin") return "launchd";
  if (Bun.which("systemctl") && existsSync("/run/systemd/system")) return "systemd";
  return "none";
}

/** Kept for callers that only care whether *some* supervisor exists. */
export function hasSystemd(): boolean {
  return supervisor() !== "none";
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function isInstalled(): Promise<boolean> {
  switch (supervisor()) {
    case "systemd":
      return existsSync(SERVICE_PATH);
    case "launchd":
      return existsSync(LAUNCHD_PLIST);
    default:
      return false;
  }
}

/**
 * Tri-state on purpose. Querying the supervisor can fail in ways that mean
 * "I could not tell", not "it is stopped" — a non-root user with no session
 * bus gets `Failed to connect to bus` from systemctl, and reporting that as
 * "not running" while the service is happily serving traffic is worse than
 * admitting ignorance.
 */
export type ServiceState = "active" | "inactive" | "unknown";

export async function state(): Promise<ServiceState> {
  switch (supervisor()) {
    case "systemd": {
      const { stdout } = await run(["systemctl", "is-active", SERVICE_NAME]);
      if (stdout === "active" || stdout === "activating") return "active";
      // systemctl prints one of these on stdout when it could actually look.
      if (["inactive", "failed", "deactivating"].includes(stdout)) return "inactive";
      return "unknown";
    }
    case "launchd": {
      const { code, stdout, stderr } = await run([
        "launchctl",
        "print",
        `${domain()}/${LAUNCHD_LABEL}`,
      ]);
      if (code === 0) return /\bpid = \d+/.test(stdout) ? "active" : "inactive";
      // launchctl says this when the label simply is not loaded.
      if (/could not find service|No such process/i.test(stderr)) return "inactive";
      return "unknown";
    }
    default:
      return "unknown";
  }
}

export async function isActive(): Promise<boolean> {
  return (await state()) === "active";
}

/** PATH for the service. Engine subprocesses inherit it, so a thin one shows
 * up much later as "command not found" inside an agent run. */
function servicePath(bunDir: string): string {
  return [
    bunDir,
    join(HOME, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].join(":");
}

function bunPath(): string {
  return Bun.which("bun") ?? join(HOME, ".bun", "bin", "bun");
}

/**
 * Who the service should run as.
 *
 * `os.userInfo().username` is not trustworthy on its own: in a container
 * entered as a uid with no USER in the environment it returns the literal
 * string "unknown". That produced a unit containing `User=unknown`, which
 * installs and enables without complaint and then fails every start with
 * `status=217/USER` — a late, opaque failure a long way from its cause.
 *
 * So: try several sources, and verify the answer resolves to a real account
 * before using it. If none does, refuse to render rather than emit a unit that
 * is guaranteed to fail.
 */
async function resolveUsername(): Promise<string> {
  let fromApi: string | undefined;
  try {
    const name = userInfo().username;
    if (name && name !== "unknown") fromApi = name;
  } catch {
    // getpwuid can fail outright in minimal environments.
  }

  const candidates = [
    fromApi,
    process.env.USER,
    process.env.LOGNAME,
    (await run(["id", "-un"])).stdout,
  ];

  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (!name || name === "unknown") continue;
    // `id -u <name>` is the cheapest "does this account exist" check.
    const resolved = await run(["id", "-u", name]);
    if (resolved.code === 0 && resolved.stdout !== "0") return name;
  }

  throw new Error(
    "could not determine a non-root user to run the service as — " +
      "set USER in the environment, or edit User= in the generated unit",
  );
}

/** Rewrite the repo's systemd unit for this box. */
export async function renderUnit(): Promise<string> {
  const template = join(REPO_ROOT, "opensession.service");
  if (!existsSync(template)) {
    throw new Error(`missing unit template at ${template}`);
  }
  const bun = bunPath();
  return (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${REPO_ROOT}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${ENV_PATH}`)
    .replace(
      /^# EXECUTOR_CREDENTIAL:.*$/m,
      "LoadCredential=executor-token:/etc/opensession/executor-token",
    )
    .replace(/^ExecStart=.*$/m, `ExecStart=${bun} run packages/core/opensession-server/opensession.ts`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(bun.replace(/\/bun$/, ""))}"`,
    );
}

function executorPathEnvironment(): string {
  const values = [
    ["HOME", HOME],
    [
      "OPENSESSION_STATE_DIR",
      process.env.OPENSESSION_STATE_DIR || envFileValue("OPENSESSION_STATE_DIR"),
    ],
    [
      "OPENSESSION_SESSIONS_DIR",
      process.env.OPENSESSION_SESSIONS_DIR ||
        envFileValue("OPENSESSION_SESSIONS_DIR"),
    ],
  ] satisfies Array<readonly [string, string | undefined]>;
  const lines: string[] = [];
  for (const [key, value] of values) {
    if (!value) continue;
    lines.push(
      `Environment="${key}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    );
  }
  return lines.join("\n");
}

/** Render the independent executor launcher unit for this box. */
export async function renderExecutorUnit(): Promise<string> {
  const template = join(REPO_ROOT, "opensession-executor.service");
  if (!existsSync(template)) {
    throw new Error(`missing executor unit template at ${template}`);
  }
  const bun = bunPath();
  return (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${await resolveUsername()}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${REPO_ROOT}`)
    .replace(/^# EXECUTOR_PATH_ENV$/m, executorPathEnvironment())
    .replace(
      /^ExecStart=.*$/m,
      `ExecStart=${bun} run packages/core/opensession-server/src/executor/main.ts`,
    )
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${servicePath(bun.replace(/\/bun$/, ""))}"`,
    );
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the macOS LaunchAgent. */
export function renderPlist(): string {
  const bun = bunPath();
  // launchd has no EnvironmentFile, so source the env file in a shell first.
  // `set -a` exports everything it defines.
  const script = `set -a; [ -f ${ENV_PATH} ] && . ${ENV_PATH}; set +a; exec ${bun} run packages/core/opensession-server/opensession.ts`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${xml(script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath(bun.replace(/\/bun$/, "")))}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, "server.err.log"))}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

export async function install(
  unitPath?: string,
  executorUnitPath?: string,
): Promise<boolean> {
  switch (supervisor()) {
    case "systemd": {
      const path = unitPath!;
      if (!executorUnitPath) {
        warn("missing rendered executor unit");
        return false;
      }
      // `enable --now` is a no-op on an already-running unit: a re-onboard
      // (say, to rebind from 127.0.0.1 to the tailnet IP) would leave the old
      // process serving with the pre-onboard env. Restart in that case so the
      // new unit and env actually take effect.
      const wasActive = await isActive();
      const executorWasActive =
        (await run(["systemctl", "is-active", EXECUTOR_SERVICE_NAME])).stdout ===
        "active";
      const executorUnit = await Bun.file(executorUnitPath).text();
      const serviceUser = executorUnit.match(/^User=(.*)$/m)?.[1];
      const bun = executorUnit.match(/^ExecStart=(\S+) run /m)?.[1];
      const servicePathValue = executorUnit.match(/^Environment="PATH=(.*)"$/m)?.[1];
      if (!serviceUser || !bun || !servicePathValue) {
        warn("rendered executor unit is missing User, ExecStart, or PATH");
        return false;
      }
      info(dim(`installing ${path} -> ${SERVICE_PATH} (needs sudo)`));
      for (const cmd of [
        [
          "sudo",
          join(REPO_ROOT, "deploy", "install-executor-credential.sh"),
          EXECUTOR_TOKEN_PATH,
        ],
        [
          "sudo",
          join(REPO_ROOT, "deploy", "install-run-host-helper.sh"),
          serviceUser,
          REPO_ROOT,
          bun,
          HOME,
          ENV_PATH,
          runHostsRoot(),
          servicePathValue,
          process.env.OPENSESSION_DEPLOY_CHECKOUT || REPO_ROOT,
          process.env.OPENSESSION_DEPLOY_STATE || join(HOME, ".opensession-deploy"),
          process.env.OPENSESSION_DEPLOY_ALLOW_RESET === "1" ? "1" : "0",
          process.env.OPENSESSION_HEALTH_URL || "http://127.0.0.1:3850/api/health",
        ],
        ["sudo", "-n", RUN_HOST_HELPER, "check"],
        ["sudo", "cp", path, SERVICE_PATH],
        ["sudo", "cp", executorUnitPath!, EXECUTOR_SERVICE_PATH],
        [
          "sudo",
          "rm",
          "-f",
          "/etc/systemd/system/opensession.service.d/executor-credential.conf",
        ],
        ["sudo", "systemctl", "daemon-reload"],
        ["sudo", "systemctl", "enable", EXECUTOR_SERVICE_NAME],
        [
          "sudo",
          "systemctl",
          executorWasActive ? "restart" : "start",
          EXECUTOR_SERVICE_NAME,
        ],
        ["sudo", "systemctl", "enable", "--now", SERVICE_NAME],
        ...(wasActive ? [["sudo", "systemctl", "restart", SERVICE_NAME]] : []),
      ]) {
        if ((await runInherit(cmd)) !== 0) {
          warn(`failed: ${cmd.join(" ")}`);
          return false;
        }
      }
      ok(wasActive ? "service reinstalled and restarted" : "service installed and started");
      return true;
    }

    case "launchd": {
      // A user LaunchAgent needs no root, which is the whole reason to prefer
      // it over a system daemon here.
      mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(LOG_DIR, { recursive: true });
      await Bun.write(LAUNCHD_PLIST, renderPlist());

      // Replace any previous registration; bootout fails harmlessly if absent.
      await run(["launchctl", "bootout", `${domain()}/${LAUNCHD_LABEL}`]);
      const { code, stderr } = await run(["launchctl", "bootstrap", domain(), LAUNCHD_PLIST]);
      if (code !== 0) {
        warn(`launchctl bootstrap failed: ${stderr}`);
        return false;
      }
      ok("LaunchAgent installed and started", LAUNCHD_PLIST);
      return true;
    }

    default:
      warn("no service manager available — run `opensession start --foreground`");
      return false;
  }
}

export async function control(action: "start" | "stop" | "restart"): Promise<number> {
  if (!(await isInstalled())) {
    warn(`no service installed — run it directly with ${dim("opensession start --foreground")}`);
    return 1;
  }

  if (supervisor() === "launchd") {
    const label = `${domain()}/${LAUNCHD_LABEL}`;
    switch (action) {
      case "start":
        return await runInherit(["launchctl", "kickstart", label]);
      case "stop":
        return await runInherit(["launchctl", "bootout", label]);
      case "restart":
        return await runInherit(["launchctl", "kickstart", "-k", label]);
    }
  }

  return await runInherit(["sudo", "systemctl", action, SERVICE_NAME]);
}

export async function logs(follow: boolean, lines: number): Promise<number> {
  if (!(await isInstalled())) {
    warn("no service installed — nothing to tail");
    return 1;
  }

  if (supervisor() === "launchd") {
    // launchd writes to the files named in the plist; there is no journal.
    const out = join(LOG_DIR, "server.log");
    if (!existsSync(out)) {
      warn(`no log file yet at ${out}`);
      return 1;
    }
    const cmd = ["tail", "-n", String(lines)];
    if (follow) cmd.push("-f");
    cmd.push(out);
    return await runInherit(cmd);
  }

  const cmd = ["journalctl", "-u", SERVICE_NAME, "-n", String(lines)];
  if (follow) cmd.push("-f");
  return await runInherit(cmd);
}
