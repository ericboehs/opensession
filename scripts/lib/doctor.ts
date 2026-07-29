/**
 * `opensession doctor` — tell the operator what is wrong, specifically.
 *
 * Written against the actual failure modes a fresh install hits, in the order
 * they bite: missing tooling, unwritten config, an integration enabled with no
 * credentials, a service that is installed but dead, a port nothing is
 * listening on.
 *
 * Exit code is non-zero only for genuine errors. Warnings (an optional binary
 * missing, no service installed) leave the exit code at 0, so `doctor` is safe
 * to use as a post-install gate in a script.
 */

import { existsSync, statSync } from "fs";
import { CONFIG_PATH, ENV_PATH, REPO_ROOT } from "./paths";
import { INTEGRATIONS } from "../../src/server/integrations/registry";
import * as service from "./service";
import { dim, fail, heading, info, ok, run, warn } from "./ui";

type Tally = { errors: number; warnings: number };

const TOOLS = [
  { bin: "bun", label: "Bun", required: true, hint: "https://bun.sh" },
  { bin: "git", label: "git", required: true, hint: "sessions run in git worktrees" },
  { bin: "gh", label: "GitHub CLI", required: false, hint: "needed for PR operations" },
  { bin: "opencode", label: "OpenCode", required: false, hint: "the engine that runs agent turns" },
  { bin: "docker", label: "Docker", required: false, hint: "optional sandboxed sessions" },
];

async function checkTools(t: Tally): Promise<void> {
  heading("Tooling");
  for (const tool of TOOLS) {
    // This CLI is itself running under Bun, so a PATH lookup failing does not
    // mean Bun is missing — it means PATH is thin (a non-login shell, cron,
    // systemd). Trust the running interpreter over the lookup.
    const path =
      Bun.which(tool.bin) ?? (tool.bin === "bun" ? process.execPath : undefined);
    if (path) {
      const { stdout } = await run([tool.bin, "--version"]);
      ok(tool.label, stdout.split("\n")[0] || path);
      continue;
    }
    if (tool.required) {
      fail(`${tool.label} missing`, tool.hint);
      t.errors++;
    } else {
      warn(`${tool.label} not found`, tool.hint);
      t.warnings++;
    }
  }
}

async function checkConfig(t: Tally): Promise<Record<string, unknown> | undefined> {
  heading("Configuration");

  if (!existsSync(CONFIG_PATH)) {
    fail(`no config at ${CONFIG_PATH}`, "run `opensession onboard`");
    t.errors++;
    return undefined;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await Bun.file(CONFIG_PATH).text());
  } catch (err) {
    fail(`config.json is not valid JSON`, (err as Error).message);
    t.errors++;
    return undefined;
  }
  ok("config.json", CONFIG_PATH);

  if (!existsSync(ENV_PATH)) {
    warn(`no env file at ${ENV_PATH}`, "integrations and secrets come from here");
    t.warnings++;
  } else {
    const mode = statSync(ENV_PATH).mode & 0o777;
    if (mode & 0o077) {
      warn(`${ENV_PATH} is mode ${mode.toString(8)}`, "should be 600 — it holds secrets");
      t.warnings++;
    } else {
      ok("env file", ENV_PATH);
    }
  }

  const repos = (config.repos ?? {}) as Record<string, { repo?: string }>;
  const ids = Object.keys(repos);
  if (!ids.length) {
    warn("no repositories registered", "sessions need at least one");
    t.warnings++;
  }
  for (const [id, repo] of Object.entries(repos)) {
    if (repo.repo && !existsSync(repo.repo)) {
      fail(`repo '${id}' points at a missing path`, repo.repo);
      t.errors++;
    } else if (repo.repo && !existsSync(`${repo.repo}/.git`)) {
      fail(`repo '${id}' is not a git checkout`, repo.repo);
      t.errors++;
    } else {
      ok(`repo '${id}'`, repo.repo);
    }
  }

  return config;
}

/**
 * An integration that is enabled but missing a required credential is the
 * single most common broken-install state: it boots, logs nothing obvious, and
 * silently does nothing.
 */
async function checkIntegrations(t: Tally, config?: Record<string, unknown>): Promise<void> {
  heading("Integrations");

  // Read the env file directly rather than trusting this process's env — the
  // CLI is usually not running under the same EnvironmentFile as the service.
  const envFile: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of (await Bun.file(ENV_PATH).text()).split("\n")) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) envFile[match[1]] = match[2].trim();
    }
  }

  const value = (name: string) => process.env[name] ?? envFile[name] ?? "";
  const configured = (config?.integrations ?? {}) as Record<string, { enabled?: boolean }>;
  let anyEnabled = false;

  // Same resolution the server uses (see integrations/load.ts): an env flag
  // wins when present, otherwise config.json decides. Checking only the env
  // file would silently miss config-enabled integrations.
  const enabled = (spec: (typeof INTEGRATIONS)[number]) => {
    const flag = value(spec.enableFlag);
    return flag ? flag === "true" : configured[spec.id]?.enabled === true;
  };

  for (const spec of INTEGRATIONS) {
    if (spec.always) continue;
    if (!enabled(spec)) continue;
    anyEnabled = true;

    const missing = spec.env.filter((e) => e.required && !value(e.name));
    if (missing.length) {
      fail(
        `${spec.label} is enabled but missing ${missing.map((m) => m.name).join(", ")}`,
        spec.doc,
      );
      t.errors++;
    } else {
      ok(`${spec.label} enabled`);
    }
  }

  if (!anyEnabled) info(dim("none enabled — that is a fine place to start"));
}

async function checkService(t: Tally, config?: Record<string, unknown>): Promise<void> {
  heading("Server");

  const kind = service.supervisor();
  if (kind === "none") {
    info(dim("no service manager here — run in the foreground with `opensession start`"));
  } else if (!(await service.isInstalled())) {
    warn(`no ${kind} service installed`, "run `opensession service install`");
    t.warnings++;
  } else {
    const state = await service.state();
    if (state === "active") {
      ok(`${kind} service active`);
    } else if (state === "inactive") {
      fail(`${kind} service installed but not running`, "`opensession logs` to see why");
      t.errors++;
    } else {
      // Could not ask. The health probe below is the real answer.
      warn(`could not query ${kind}`, "no permission or no session bus");
      t.warnings++;
    }
  }

  const server = (config?.server ?? {}) as { host?: string; port?: number };
  const host = server.host === "0.0.0.0" ? "127.0.0.1" : server.host || "127.0.0.1";
  const port = server.port || 3850;

  try {
    const res = await fetch(`http://${host}:${port}/backstage/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) ok(`responding on ${host}:${port}`);
    else {
      warn(`health endpoint returned ${res.status}`, `http://${host}:${port}`);
      t.warnings++;
    }
  } catch {
    info(dim(`nothing responding on ${host}:${port} (not running?)`));
  }
}

export async function doctor(): Promise<number> {
  const t: Tally = { errors: 0, warnings: 0 };

  info(dim(`checkout ${REPO_ROOT}`));
  await checkTools(t);
  const config = await checkConfig(t);
  await checkIntegrations(t, config);
  await checkService(t, config);

  heading("Summary");
  if (!t.errors && !t.warnings) ok("everything looks healthy");
  else info(`${t.errors} error(s), ${t.warnings} warning(s)`);
  console.log("");

  return t.errors ? 1 : 0;
}
