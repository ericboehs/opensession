#!/usr/bin/env bun
/**
 * Interactive first-run setup for a fresh OpenSession install.
 *
 * Turns the ~1400 lines of docs/setup/ into a guided flow that gets a bare
 * box to a booting server. It writes the two files the server actually reads
 * (`~/.opensession/config.json` and `~/.opensession.env`) and, optionally, a
 * systemd unit templated to THIS checkout — the repo's `opensession.service`
 * is a copy of Tella's deployed unit with `/home/ubuntu/projects/tella-
 * backstage`, `User=ubuntu` and `/home/ubuntu/.bun/bin/bun` baked in, so it
 * cannot be used verbatim anywhere else.
 *
 * The load-bearing step is the env file. Integration feature flags default
 * ON and only the literal string "false" disables them (docs/setup/
 * integrations-misc.md#boot-guards), so a fresh install with no tokens boots
 * every agent loop against nothing. This writes an explicit ENABLE_*=false
 * for each integration you don't configure.
 *
 * Nothing here is destructive: existing files are backed up to
 * `<file>.bak-<n>` and never silently overwritten.
 *
 * Usage:
 *   bun run setup              # interactive
 *   bun run setup --yes        # accept every default, no prompts (CI/scripted)
 *   bun run setup --check      # preflight only, write nothing
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync } from "fs";
import { homedir, userInfo } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const HOME = homedir();
const USER = userInfo().username;

const ARGS = new Set(process.argv.slice(2));
const YES = ARGS.has("--yes") || ARGS.has("-y");
const CHECK_ONLY = ARGS.has("--check");
const FORCE = ARGS.has("--force");
const INTERACTIVE = process.stdin.isTTY && !YES && !CHECK_ONLY;

const CONFIG_DIR = join(HOME, ".opensession");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ENV_PATH = join(HOME, ".opensession.env");

// ── output helpers ──────────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function heading(s: string) {
  console.log(`\n${bold(s)}`);
}

function ask(question: string, fallback: string): string {
  if (!INTERACTIVE) return fallback;
  const answer = prompt(`${question} ${dim(`[${fallback}]`)}`);
  return answer?.trim() || fallback;
}

function askYesNo(question: string, fallback: boolean): boolean {
  if (!INTERACTIVE) return fallback;
  const hint = fallback ? "Y/n" : "y/N";
  const answer = prompt(`${question} ${dim(`[${hint}]`)}`)?.trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

/** Back up an existing file rather than clobbering a working install. */
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let n = 1;
  while (existsSync(`${path}.bak-${n}`)) n++;
  const dest = `${path}.bak-${n}`;
  copyFileSync(path, dest);
  return dest;
}

// ── preflight ───────────────────────────────────────────────────────────────

type Tool = {
  bin: string;
  label: string;
  required: boolean;
  versionArgs: string[];
  hint: string;
};

const TOOLS: Tool[] = [
  {
    bin: "bun",
    label: "Bun",
    required: true,
    versionArgs: ["--version"],
    hint: "https://bun.sh — runtime, package manager and bundler. No Node/Vite.",
  },
  {
    bin: "git",
    label: "git",
    required: true,
    versionArgs: ["--version"],
    hint: "Sessions run in git worktrees cut from your registered repos.",
  },
  {
    bin: "gh",
    label: "GitHub CLI",
    required: false,
    versionArgs: ["--version"],
    hint: "https://cli.github.com — needed for PR create/read. Run `gh auth login`.",
  },
  {
    bin: "opencode",
    label: "OpenCode",
    required: false,
    versionArgs: ["--version"],
    hint: "The engine that runs agent turns. Without it sessions cannot execute.",
  },
  {
    bin: "docker",
    label: "Docker",
    required: false,
    versionArgs: ["--version"],
    hint: "Optional: sandboxed sessions (docs/self-hosting-sandboxes.md).",
  },
];

async function which(bin: string): Promise<string | undefined> {
  const found = Bun.which(bin);
  return found ?? undefined;
}

async function version(tool: Tool): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([tool.bin, ...tool.versionArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function preflight(): Promise<boolean> {
  heading("Preflight");
  let missingRequired = false;

  for (const tool of TOOLS) {
    const path = await which(tool.bin);
    if (!path) {
      const mark = tool.required ? red("missing") : yellow("not found");
      console.log(`  ${mark}  ${tool.label}`);
      console.log(`          ${dim(tool.hint)}`);
      if (tool.required) missingRequired = true;
      continue;
    }
    const v = await version(tool);
    console.log(`  ${green("ok")}      ${tool.label} ${dim(v ?? path)}`);
  }

  if (!existsSync(join(REPO_ROOT, "node_modules"))) {
    console.log(
      `  ${yellow("todo")}    dependencies not installed — run ${bold("bun install")}`,
    );
  }

  return !missingRequired;
}

// ── config.json ─────────────────────────────────────────────────────────────

type Answers = {
  productName: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  repoId: string;
  repoPath: string;
  repoBranch: string;
  worktreesDir: string;
};

function collectAnswers(): Answers {
  heading("Instance configuration");
  console.log(
    dim(
      "  Every field is optional; precedence is env var -> config.json -> built-in\n" +
        "  default. config.json is re-read on change, so none of this needs a restart.",
    ),
  );

  const productName = ask("  Product name", "OpenSession");
  const host = ask(
    "  Bind address (127.0.0.1, or a Tailscale IP to share with your team)",
    "127.0.0.1",
  );
  const port = Number(ask("  Port", "3850")) || 3850;
  const publicBaseUrl = ask(
    "  Public base URL (used in links posted to Slack/Linear/notes)",
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
  );

  console.log(
    dim(
      "\n  Register your first repo. With no `repos` entry this checkout registers\n" +
        "  itself as the shared `opensession` repo.",
    ),
  );
  const repoPath = ask("  Repo checkout path", REPO_ROOT);
  const repoId = ask(
    "  Repo id (short key used in the UI and APIs)",
    repoPath === REPO_ROOT ? "opensession" : repoPath.split("/").pop() || "app",
  );
  const repoBranch = ask("  Default branch", "main");
  const worktreesDir = ask(
    "  Where should session worktrees be created?",
    join(HOME, "worktrees"),
  );

  return {
    productName,
    host,
    port,
    publicBaseUrl,
    repoId,
    repoPath,
    repoBranch,
    worktreesDir,
  };
}

/** "OpenSession" -> "OS". Falls back to the first two characters. */
function deriveMark(name: string): string {
  const caps = name.replace(/[^A-Z]/g, "");
  return caps.length >= 2 ? caps.slice(0, 2) : name.slice(0, 2).toUpperCase();
}

function buildConfig(a: Answers): Record<string, unknown> {
  return {
    server: {
      host: a.host,
      port: a.port,
      webhookPort: 3848,
      publicBaseUrl: a.publicBaseUrl,
    },
    paths: {
      worktreesDir: a.worktreesDir,
      mcpConfig: join(REPO_ROOT, "mcp-config.json"),
    },
    branding: {
      productName: a.productName,
      productMark: deriveMark(a.productName),
    },
    repos: {
      [a.repoId]: {
        label: a.productName,
        repo: a.repoPath,
        wtPrefix: a.repoId,
        defaultBranch: a.repoBranch,
        default: true,
      },
    },
    // Populate with your teammates to enable commit attribution, per-user MCP
    // `allowedUsers` gating and human-ask routing. An empty roster makes every
    // identity-dependent feature a no-op.
    identity: { team: [] },
  };
}

// ── .opensession.env ────────────────────────────────────────────────────────

const INTEGRATIONS = [
  { flag: "ENABLE_SLACK_AGENT", label: "Slack agent", doc: "docs/setup/slack.md" },
  { flag: "ENABLE_LINEAR_AGENT", label: "Linear agent", doc: "docs/setup/linear.md" },
  { flag: "ENABLE_PLAIN_AGENT", label: "Plain agent", doc: "docs/setup/plain.md" },
  { flag: "ENABLE_GITHUB_AGENT", label: "GitHub agent", doc: "docs/setup/github.md" },
  {
    flag: "ENABLE_STRIPE_AGENT",
    label: "Stripe agent",
    doc: "docs/setup/integrations-misc.md",
  },
  {
    flag: "ENABLE_GRAFANA_POLLER",
    label: "Grafana poller",
    doc: "docs/setup/integrations-misc.md",
  },
];

function buildEnv(a: Answers): string {
  const lines = [
    "# OpenSession secrets and environment.",
    "# Loaded by the systemd unit via EnvironmentFile, and by Bun for manual runs",
    "# started from the repo root. Generated by `bun run setup`.",
    "",
    "# --- core server ---",
    `HOST=${a.host}`,
    `PORT=${a.port}`,
    "WEBHOOK_PORT=3848",
    `OPENSESSION_UI_BASE=${a.publicBaseUrl}`,
    `OPENSESSION_WORKTREES_DIR=${a.worktreesDir}`,
    "",
    "# --- integrations ---",
    "# These flags default ON and only the literal string `false` disables them,",
    "# so an unconfigured integration still starts its loop. Flip one to `true`",
    "# only once you have added its credentials — see the doc next to each.",
  ];

  for (const i of INTEGRATIONS) {
    lines.push(`# ${i.label} — ${i.doc}`);
    lines.push(`${i.flag}=false`);
  }

  lines.push(
    "",
    "# --- credentials ---",
    "# Add per-integration tokens here as you enable them. Agent subprocesses do",
    "# NOT inherit this file: runs get a minimal env (PATH, HOME, LANG,",
    "# OPENSESSION_MODEL) by design, and MCP servers carry their own credentials.",
    "",
  );

  return lines.join("\n");
}

// ── systemd ─────────────────────────────────────────────────────────────────

async function buildUnit(): Promise<string | undefined> {
  const template = join(REPO_ROOT, "opensession.service");
  if (!existsSync(template)) return undefined;

  const bunPath = (await which("bun")) ?? join(HOME, ".bun", "bin", "bun");
  const bunDir = bunPath.replace(/\/bun$/, "");

  return (await Bun.file(template).text())
    .replace(/^User=.*$/m, `User=${USER}`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${REPO_ROOT}`)
    .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${ENV_PATH}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${bunPath} run opensession.ts`)
    .replace(
      /^Environment="PATH=.*"$/m,
      `Environment="PATH=${bunDir}:${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`,
    );
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(bold("\nOpenSession setup"));
console.log(dim(`  checkout ${REPO_ROOT}`));
console.log(dim(`  user     ${USER}`));

const ok = await preflight();

if (CHECK_ONLY) {
  console.log(ok ? green("\nPreflight passed.\n") : red("\nPreflight failed.\n"));
  process.exit(ok ? 0 : 1);
}

if (!ok) {
  console.log(red("\nInstall the missing required tools above, then re-run.\n"));
  process.exit(1);
}

// Re-running setup against a live install would replace a working config with
// defaults. Backups make that recoverable, not harmless — so an existing
// config needs an explicit confirmation (or --force when scripted).
if (existsSync(CONFIG_PATH) && !FORCE) {
  console.log(yellow(`\n  ${CONFIG_PATH} already exists — this box is already set up.`));
  if (!INTERACTIVE) {
    console.log(
      `  Re-run with ${bold("--force")} to overwrite it (the old file is backed up first).\n`,
    );
    process.exit(1);
  }
  if (!askYesNo("  Overwrite it? The current file is backed up first.", false)) {
    console.log(dim("\n  Left untouched. Nothing written.\n"));
    process.exit(0);
  }
}

const answers = collectAnswers();

heading("Writing configuration");

mkdirSync(CONFIG_DIR, { recursive: true });
mkdirSync(answers.worktreesDir, { recursive: true });

for (const [path, contents, mode] of [
  // 0600 on both: config.json carries the team identity table (emails, Slack
  // ids, GitHub logins), not just ports.
  [CONFIG_PATH, JSON.stringify(buildConfig(answers), null, 2) + "\n", 0o600],
  [ENV_PATH, buildEnv(answers), 0o600],
] as const) {
  const backedUp = backup(path);
  await Bun.write(path, contents);
  chmodSync(path, mode);
  console.log(
    `  ${green("wrote")}   ${path}${backedUp ? dim(`  (backed up to ${backedUp})`) : ""}`,
  );
}

const unit = await buildUnit();
if (unit) {
  const unitPath = join(CONFIG_DIR, "opensession.service");
  await Bun.write(unitPath, unit);
  console.log(`  ${green("wrote")}   ${unitPath} ${dim("(templated for this box)")}`);

  if (askYesNo("\n  Install and start it as a systemd service now?", false)) {
    const dest = "/etc/systemd/system/opensession.service";
    console.log(dim(`\n  Needs sudo. Running:`));
    console.log(dim(`    sudo cp ${unitPath} ${dest}`));
    console.log(dim(`    sudo systemctl daemon-reload && sudo systemctl enable --now opensession`));
    for (const cmd of [
      ["sudo", "cp", unitPath, dest],
      ["sudo", "systemctl", "daemon-reload"],
      ["sudo", "systemctl", "enable", "--now", "opensession"],
    ]) {
      const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
      if ((await proc.exited) !== 0) {
        console.log(red(`\n  Failed: ${cmd.join(" ")}`));
        break;
      }
    }
  }
}

heading("Next steps");
console.log(`  1. ${bold("bun install")}                 ${dim("if you have not already")}`);
console.log(`  2. ${bold("bun run opensession.ts")}      ${dim("start it in the foreground")}`);
console.log(`     ${dim(`then open ${answers.publicBaseUrl}`)}`);
console.log(
  `  3. ${bold("opencode auth login")}         ${dim("give the engine model capacity — docs/setup/engines.md")}`,
);
console.log(
  `  4. ${dim("enable integrations one at a time in")} ${ENV_PATH} ${dim("— docs/setup/")}`,
);
console.log(
  yellow(
    `\n  Note: OpenSession has no built-in authentication. It trusts everyone who\n` +
      `  can reach ${answers.host}:${answers.port}. Keep it on Tailscale or an equivalent\n` +
      `  private network — never expose it publicly. (docs/setup/README.md#trust-model)\n`,
  ),
);
