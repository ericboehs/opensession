/**
 * OpenCode runner: the third engine next to claude-runner and codex-runner
 * (docs/sandboxes-plan.md, Workstream E). Wraps a per-session `opencode serve`
 * HTTP server (OpenCode is MIT, 75+ providers) in the same StreamEvent
 * generator shape, so the chat pipeline / journal / audit contract downstream
 * doesn't care which backend serves the model.
 *
 * Activation is explicit: only model ids prefixed `opencode/<provider>/<model>`
 * (e.g. opencode/anthropic/claude-sonnet-5, opencode/openai/gpt-5.5) reach
 * this runner — nothing defaults to it. Provider auth is OpenCode's own
 * (`opencode auth login` → ~/.local/share/opencode/auth.json; HOME is passed
 * through), except two subscription paths: `opencode/openai/*` runs on our
 * ChatGPT-subscription auth (the codex accounts pool, seeded per-account — see
 * opencode-openai-auth.ts), and `opencode/anthropic/*`, which runs on
 * Claude-subscription capacity via one of two bridges selected by `bridge.mode`
 * in ~/.backstage-opencode.json (see opencode-config.ts):
 *
 *  - "meridian" (the default when enabled; Michiel's 2026-07-08 directive):
 *    the literal opencode-with-claude + @rynfar/meridian stack, bundled as
 *    exact-pinned npm deps and injected as an OpenCode plugin into the
 *    session's server config. The plugin starts Meridian in-process inside
 *    `opencode serve` (ephemeral loopback port, per-server MERIDIAN_API_KEY
 *    auth) and Meridian drives the official Claude Agent SDK. Completes turns
 *    on flat subscription quota (verified live 2026-07-08) — its bundled
 *    scrub plugin removes the opencode prompt fingerprints Anthropic's
 *    third-party-billing classifier keys on. Per-run account selection is
 *    ours: pool + the run user's own personal accounts (optionally restricted
 *    to bridge.accounts), pinned into the server via CLAUDE_CONFIG_DIR
 *    isolation + CLAUDE_CODE_OAUTH_TOKEN (see meridianAccountEnv).
 *  - "native": our own anthropic-bridge.ts (Agent SDK reimplementation with
 *    per-request HTTP audit and NO fingerprint scrubbing — Anthropic bills it
 *    to extra-usage credits). Kept selectable as the anti-evasion fallback.
 *  - "off" / config missing / enabled:false: anthropic models fail with a
 *    clear error.
 *
 * Audit granularity differs by mode: the native bridge audits EVERY HTTP
 * request (anthropic_bridge_request in/out); meridian runs inside the opencode
 * server process where we have no per-request hook, so we emit RUN-level
 * events instead (`opencode_meridian_run` start/end with session, model,
 * account, versions) — per-request detail exists only in opencode's own log
 * (~/.local/share/opencode/log/).
 *
 * Server lifecycle: one `opencode serve` process per backstage session (keyed
 * by bks session id, falling back to cwd), bound to 127.0.0.1 on an ephemeral
 * port with a per-server Basic-auth password, cwd = the session worktree, and
 * a minimal env (PATH/HOME/LANG + git identity — mirrors codexEnv; no
 * backstage tokens). Parked on globalThis so `bun --hot` reloads keep servers
 * alive; killed after 30 minutes idle. Config (permissions, MCP servers,
 * bridge provider override, meridian plugin) is injected via
 * OPENCODE_CONFIG_CONTENT at spawn; a config OR per-server-env change (e.g. a
 * different meridian account was picked) respawns the server (sessions persist
 * in OpenCode's own storage, so this is safe between runs). In meridian mode
 * the Meridian proxy + its Agent SDK children live inside/under the opencode
 * server process, so killing the server reaps them too — but the meridian
 * plugin installs SIGTERM/SIGINT handlers that swallow the default terminate
 * action (verified live 2026-07-08: a meridian-enabled server survives
 * SIGTERM), so killServer escalates to SIGKILL after a short grace. The
 * 30-min idle kill and shutdown paths go through the same killServer.
 *
 * Permission model vs the Claude runner:
 *  - mode "ask" ⇒ read-only permission config: edit denied, bash restricted to
 *    a read-only command allowlist (everything else denied), write/edit/patch
 *    tools disabled. Backstop: any OpenCode permission ask that still surfaces
 *    is auto-rejected (there is no interactive permission bridge here yet).
 *  - `confirmTools` (per-call human approval, e.g. money-moving Stripe) have
 *    no approval bridge on this engine, so every MCP server with a
 *    confirm-listed tool is DROPPED from the run entirely (fail closed — we
 *    don't trust name-mangling a per-tool disable across engines for
 *    money-moving tools). The instructions note tells the agent to propose
 *    such actions for a human instead.
 *  - Automations (and interactive resumes of automation sessions) are HARD
 *    GATED off this engine, deny-by-default: only runs with an explicit
 *    interactive journal kind (prompt/goal/create + resume/rerun/fallback
 *    derivatives) or the explicit `allowOpencode` trusted-caller marker
 *    (verify scripts) pass; any `deniedTools` or unknown/absent kind gets an
 *    immediate error event and nothing is started. Automation least-privilege
 *    therefore never depends on OpenCode config.
 *
 * Failure containment: each run watches `proc.exited` for its server, so a
 * mid-turn `opencode serve` death emits a clean error event (instead of
 * wedging the drain loop on `wake` forever and holding the session busy),
 * removes the dead server from the pool, and lets normal cleanup run. Each
 * turn also carries a hard wall-clock deadline (default 60 min,
 * `turnTimeoutMinutes` in ~/.backstage-opencode.json) that aborts the turn
 * with a clear error.
 *
 * Steering/interrupt: OpenCode has no mid-turn steer API, so steers fall back
 * to the caller's queue (same as exec-transport Codex); cancel maps to
 * `POST /session/:id/abort` + process-level abort.
 *
 * Resume after a backstage restart: the journal records the OpenCode session
 * id (in ActiveRunRecord.claudeSessionId, like Codex thread ids) and the full
 * `opencode/...` model id, so the dispatcher routes the resume back here and
 * we re-prompt the same OpenCode session (a fresh `opencode serve` finds it in
 * OpenCode's on-disk storage). What resume CANNOT preserve: the interrupted
 * turn's in-flight output/tool state (the continuation prompt asks the model
 * to review and pick up), any queued-but-undelivered steers, and pending
 * permission asks.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Subprocess } from "bun";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { RunAgentOpts } from "./agent-runner";
import {
  journalSet,
  journalClear,
  filterMcpServers,
  isClaudeUsageLimitError,
  CLAUDE_CODE_BIN,
  type StreamEvent,
  type ImageInput,
} from "./claude-runner";
import { audit, summarizeText } from "./audit";
import { gitIdentityEnv, userMatchesAny, type GitIdentity } from "./shared/user-mappings";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { BUN_BIN, MCP_PROXY_ENTRY, rpcSocketPath } from "./run-rpc-protocol";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { isCodexUsageLimitError } from "./codex-runner";
import {
  appendOpencodeTranscript,
  ensureOpencodeTranscriptFile,
  transcriptLineUser,
  transcriptLineAssistantText,
  transcriptLineToolUse,
  transcriptLineToolResult,
} from "./opencode-transcript";
import { ensureAnthropicBridge } from "./anthropic-bridge";
import {
  pickOpenaiAccount,
  bindOpenaiAccount,
  maskOpenaiAccount,
  opencodeHasNativeOpenaiAuth,
} from "./opencode-openai-auth";
import { opencodeTurnTimeoutMs, readOpencodeBridgeConfig } from "./opencode-config";
import {
  pickAccount,
  getUsableAccountById,
  getAccountById,
  markExhausted,
  type ClaudeAccount,
} from "./claude-accounts";

const HOME = process.env.HOME || "/home/ubuntu";
const UI_BASE =
  process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

/** opencode binary (installed user-level: `npm i -g opencode-ai`). */
export const OPENCODE_BIN =
  process.env.BACKSTAGE_OPENCODE_BIN || Bun.which("opencode") || `${HOME}/.nvm/versions/node/v20.20.0/bin/opencode`;

const OPENCODE_STATE_DIR = `${BACKSTAGE_CHATS_DIR}/opencode`;
const SERVER_START_TIMEOUT_MS = 30_000;
const IDLE_KILL_MS = 30 * 60 * 1000;

const PROVIDER = "opencode" as const;

export const OPENCODE_MODEL_PREFIX = "opencode/";

/** Split `opencode/<provider>/<model>` (model may itself contain slashes). */
export function parseOpencodeModel(
  model: string
): { providerID: string; modelID: string } | null {
  if (!model.startsWith(OPENCODE_MODEL_PREFIX)) return null;
  const rest = model.slice(OPENCODE_MODEL_PREFIX.length);
  const sep = rest.indexOf("/");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerID: rest.slice(0, sep), modelID: rest.slice(sep + 1) };
}

// ── Automation hard gate ─────────────────────────────────────────────────────

/** Journal kinds minted by trusted interactive paths (backstage.ts:
 *  runSessionPromptInner "prompt", goal wakes "goal", both create paths
 *  "create"; host/sandbox run specs default `journalKind || "prompt"`).
 *  Everything else — automation, action, github-…, security-scan, their
 *  -resume/-rerun/-fallback derivatives, AND runs with no journal kind at
 *  all — is fail-closed off this engine (deny by default). */
const INTERACTIVE_KINDS = new Set(["prompt", "goal", "create"]);

/** Non-null = the reason this run may not use the opencode engine. */
export function opencodeGateReason(opts: {
  deniedTools?: Record<string, string>;
  journal?: { kind?: string };
  /** Explicit trusted-caller marker (scripts/verify-opencode.ts) for direct
   *  runOpencode calls that deliberately pass no journal. Never set this from
   *  request/automation data — the deniedTools check still applies. */
  allowOpencode?: boolean;
}): string | null {
  if (Object.keys(opts.deniedTools || {}).length > 0) {
    return (
      "The opencode engine is not available to automation runs (this run carries deniedTools — " +
      "the automation least-privilege set). Use a claude-* or gpt-* model instead."
    );
  }
  if (opts.allowOpencode === true) return null;
  const base = (opts.journal?.kind || "").replace(/(-(resume|rerun|fallback))+$/, "");
  if (!INTERACTIVE_KINDS.has(base)) {
    return base
      ? `The opencode engine is not available to "${base}" runs — interactive sessions only.`
      : "The opencode engine requires an explicit interactive run kind (journal.kind) — " +
          "deny by default; interactive sessions only.";
  }
  return null;
}

// ── Meridian bridge (opencode/anthropic/* default path) ──────────────────────
//
// VERSION PINNING (package.json): opencode-with-claude 1.6.14 +
// @rynfar/meridian 1.45.0 + @rynfar/meridian-plugin-opencode-scrub 0.2.0 are
// pinned EXACT. These versions chase Anthropic's third-party billing-gate
// behavior (the scrub plugin exists to keep turns on flat subscription quota);
// bump deliberately after watching the repos' releases, and re-run
// scripts/verify-opencode.ts against a scratch config before shipping a bump.

interface MeridianStackInfo {
  /** Absolute path to the plugin entry, injected into OPENCODE_CONFIG_CONTENT `plugin`. */
  pluginPath: string;
  pluginVersion: string;
  meridianVersion: string;
}

let cachedMeridianStack: MeridianStackInfo | undefined;

function pkgVersionNear(entryPath: string): string {
  try {
    // dist/index.js → ../package.json (both packages ship dist/ at the root).
    return JSON.parse(readFileSync(join(dirname(entryPath), "..", "package.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** Resolve the bundled opencode-with-claude plugin (throws a clear error when
 *  the packages are missing — e.g. a checkout without `bun install`). */
export function meridianStackInfo(): MeridianStackInfo {
  if (cachedMeridianStack) return cachedMeridianStack;
  let pluginPath: string;
  let meridianEntry: string;
  try {
    pluginPath = Bun.resolveSync("opencode-with-claude", import.meta.dir);
    meridianEntry = Bun.resolveSync("@rynfar/meridian", import.meta.dir);
  } catch (e: any) {
    throw new Error(
      "The meridian bridge packages are not installed (opencode-with-claude / @rynfar/meridian) — " +
        `run \`bun install\` in the backstage checkout. (${e?.message || e})`
    );
  }
  cachedMeridianStack = {
    pluginPath,
    pluginVersion: pkgVersionNear(pluginPath),
    meridianVersion: pkgVersionNear(meridianEntry),
  };
  return cachedMeridianStack;
}

/** Per-account Claude config dirs for Meridian's SDK subprocesses. Isolating
 *  CLAUDE_CONFIG_DIR is what actually pins the account: with the host HOME
 *  passed through, the claude CLI silently falls back to ~/.claude/
 *  .credentials.json (the host login) even when CLAUDE_CODE_OAUTH_TOKEN is
 *  set — verified live 2026-07-08 (an invalid env token still completed via
 *  the host store; with an isolated CLAUDE_CONFIG_DIR it hard-fails instead).
 *  So each account gets an empty config dir + the env token: the selected
 *  account is the only reachable credential, and a bad token fails closed
 *  instead of burning the host login's quota. */
const MERIDIAN_CFG_ROOT = `${HOME}/.backstage-opencode/meridian-cfg`;

/**
 * Env for a meridian-mode `opencode serve` process. The Meridian proxy runs
 * in-process in that server (the plugin calls startProxyServer) and passes its
 * process env through to the Agent SDK subprocess, so this is the per-session
 * account-auth channel. Note the token is therefore visible to the session's
 * own shell tools via `env` — the same exposure class as claude-runner, whose
 * SDK subprocess (and its Bash children) carry CLAUDE_CODE_OAUTH_TOKEN today.
 */
export function meridianAccountEnv(account: ClaudeAccount, meridianKey: string): Record<string, string> {
  const cfgDir = `${MERIDIAN_CFG_ROOT}/${account.id}`;
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  return {
    CLAUDE_CODE_OAUTH_TOKEN: account.token,
    CLAUDE_CONFIG_DIR: cfgDir,
    // Loopback-only is Meridian's default bind; MERIDIAN_API_KEY additionally
    // requires x-api-key on every /v1/* request (verified live: 401 without
    // it), so another local process can't ride the proxy. The same key is set
    // as the opencode anthropic provider apiKey.
    MERIDIAN_API_KEY: meridianKey,
    // Always take an OS-assigned port (never the shared 3456 default) — one
    // Meridian per opencode server, no cross-server port contention.
    CLAUDE_PROXY_PORT: "0",
    // Deterministic SDK executable (same binary claude-runner uses) instead of
    // Meridian's bundled/platform/PATH probing.
    MERIDIAN_CLAUDE_PATH: CLAUDE_CODE_BIN,
  };
}

/**
 * Pick the account a meridian run authenticates as. `ids` (bridge.accounts)
 * restricts to designated accounts in list order; otherwise the normal
 * accounts-layer pick (personal-first for the run user, then shared pool).
 * Either way another user's personal account is never used — same rule as
 * accountsForRemoteUpload (fail closed).
 */
export function pickMeridianAccount(
  user: string | undefined,
  model: string,
  ids?: string[]
): ClaudeAccount | { error: string } {
  const allowedOwner = (a: ClaudeAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  if (ids?.length) {
    for (const id of ids) {
      const a = getUsableAccountById(id, model);
      if (a && allowedOwner(a)) return a;
    }
    const known = ids.map((id) => getAccountById(id)?.name || id).join(", ");
    return { error: `no designated meridian bridge account is currently usable (tried: ${known})` };
  }
  const picked = pickAccount(undefined, user, model);
  if (picked) return picked;
  return { error: "no usable Claude account for the meridian bridge (pool exhausted or none configured)" };
}

// ── OpenCode config generation ───────────────────────────────────────────────

/** Read-only bash surface for ask mode: allow common inspection commands,
 *  deny everything else (opencode matches most-specific pattern first). */
const ASK_BASH_PERMISSIONS: Record<string, "allow" | "deny"> = {
  "cat *": "allow", "ls*": "allow", "rg *": "allow", "grep *": "allow",
  "find *": "allow", "head *": "allow", "tail *": "allow", "wc *": "allow",
  "tree*": "allow", "file *": "allow", "stat *": "allow", "du *": "allow",
  "df*": "allow", "which *": "allow", "pwd": "allow", "echo *": "allow",
  "git status*": "allow", "git log*": "allow", "git diff*": "allow",
  "git show*": "allow", "git branch*": "allow", "git blame*": "allow",
  "git grep*": "allow", "git ls-files*": "allow",
  "*": "deny",
};

const CONFIRM_TOOL_RE = /^mcp__(.+)__(.+)$/;

/**
 * Map our mcp-config.json (filtered by the per-automation allowlist AND the
 * per-user allowedUsers gate — both via filterMcpServers, the same helper the
 * Claude runner enforces with) onto OpenCode's `mcp` config shape. Servers
 * with confirm-listed (human-approval) tools are dropped entirely; see module
 * doc. Returns the dropped names so the instructions can say so.
 */
export function buildOpencodeMcpConfig(
  allowlist: string[] | undefined,
  user: string | undefined,
  confirmTools: Record<string, string> | undefined
): { mcp: Record<string, Record<string, unknown>>; droppedForConfirm: string[] } {
  const confirmServers = new Set<string>();
  for (const name of Object.keys(confirmTools || {})) {
    const m = name.match(CONFIRM_TOOL_RE);
    if (m) confirmServers.add(m[1].split("__")[0]);
  }
  const filtered = filterMcpServers(allowlist, user) as Record<string, any>;
  const mcp: Record<string, Record<string, unknown>> = {};
  const droppedForConfirm: string[] = [];
  for (const [name, cfg] of Object.entries(filtered)) {
    if (confirmServers.has(name)) {
      droppedForConfirm.push(name);
      continue;
    }
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      mcp[name] = {
        type: "remote",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        // Our headers carry the auth; don't let OAuth auto-detection interfere.
        oauth: false,
        enabled: true,
        timeout: 30_000,
      };
    } else if (cfg.command) {
      mcp[name] = {
        type: "local",
        command: [cfg.command, ...((cfg.args as string[]) || [])],
        ...(cfg.env ? { environment: cfg.env } : {}),
        enabled: true,
        timeout: 30_000,
      };
    }
  }
  return { mcp, droppedForConfirm };
}

/** In-process michael-* servers, exposed as stdio proxies that forward to the
 *  backstage process over the run-rpc socket — the exact pattern Codex uses
 *  (codex-runner proxyMcpConfigs), in OpenCode's config shape. */
export function proxyOpencodeMcpConfigs(
  inProcessMcp: Record<string, unknown> | undefined,
  rpcToken: string | undefined
): Record<string, Record<string, unknown>> {
  if (!inProcessMcp || !rpcToken) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(inProcessMcp)) {
    out[name] = {
      type: "local",
      command: [BUN_BIN, "run", MCP_PROXY_ENTRY],
      environment: {
        BKS_RPC_SOCKET: rpcSocketPath(BACKSTAGE_CHATS_DIR),
        BKS_RPC_TOKEN: rpcToken,
        BKS_MCP_SERVER: name,
      },
      enabled: true,
      timeout: 60_000,
    };
  }
  return out;
}

/** Runner-host context (sandboxed and systemd-hosted runs): `inProcessMcp`
 *  arrives as ALREADY-BUILT stdio proxy configs (host.ts proxyMcpConfigs —
 *  command/args/env carrying the spec's HOST-registered rpc token and the
 *  right transport env, unix socket or rpc-ws). Pass those through verbatim:
 *  rebuilding them here would mint a fresh token the backstage process never
 *  registered (run-rpc auth lives there, not in this process) and point at
 *  BUN_BIN, a host path that doesn't exist inside a sandbox container.
 *  Returns null when the values are in-process SDK server instances (the
 *  backstage-process path) — the caller then builds its own proxies via
 *  proxyOpencodeMcpConfigs. */
export function opencodeMcpFromPrebuiltProxies(
  inProcessMcp: Record<string, unknown> | undefined
): Record<string, Record<string, unknown>> | null {
  const entries = Object.entries(inProcessMcp || {});
  if (!entries.length) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of entries) {
    const cfg = raw as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof cfg?.command !== "string") return null; // SDK instance → not prebuilt
    out[name] = {
      type: "local",
      command: [cfg.command, ...((Array.isArray(cfg.args) ? cfg.args : []) as string[])],
      ...(cfg.env ? { environment: cfg.env } : {}),
      enabled: true,
      timeout: 60_000,
    };
  }
  return out;
}

/** Session context (ask guardrails, repos note, managing-Michael notes) —
 *  delivered via an instructions file, OpenCode's system-prompt append
 *  channel. Sibling of buildCodexDeveloperInstructions with engine-accurate
 *  wording. */
export function buildOpencodeInstructions(input: {
  isAsk: boolean;
  reposNote?: string;
  inProcessMcp?: Record<string, unknown>;
  bksSessionId?: string;
  droppedForConfirm?: string[];
}): string {
  const parts: string[] = [];
  if (input.isAsk) {
    parts.push(
      "You are Michael in Ask mode: answer questions about the current checkout. " +
        "This is a READ-ONLY session — never modify, create, or delete files, never commit, " +
        "never run state-changing commands (the permission config enforces this). Explore with " +
        "read-only shell and git commands, then answer clearly and concisely."
    );
  }
  if (input.reposNote) parts.push(input.reposNote);
  if (!input.isAsk && input.bksSessionId) {
    const link = `${UI_BASE}/session/${input.bksSessionId}`;
    parts.push(
      "## Session link in PRs\nWhenever you open a pull request (any repo, via `gh pr create` " +
        "or otherwise), include a link back to this Michael session at the end of the PR body:\n\n" +
        `Created by [this Michael session](${link})`
    );
  }
  if (input.inProcessMcp && Object.keys(input.inProcessMcp).length) {
    parts.push(
      "## Managing Michael\nYou can see and steer your other Backstage sessions via the " +
        "michael-sessions MCP tools (list_sessions, get_session, send_to_session, " +
        "answer_session_question, cancel_session, create_session), manage setup via " +
        "michael-admin, ask teammates via michael-humans, and attach/switch repos via " +
        "michael-repos when those servers are available."
    );
    if ((input.inProcessMcp as Record<string, unknown>)["michael-ask"]) {
      parts.push(
        "## Asking the human a question\nWhen you genuinely need the human's decision to " +
          "proceed, call michael-ask's `ask_user` tool. It pauses this run on a question card " +
          "in the Backstage UI and returns their answer. Prefer 2-4 concrete options; don't " +
          "ask for confirmations a reasonable default covers."
      );
    }
  }
  if (input.droppedForConfirm?.length) {
    parts.push(
      `## Run policy\nThe ${input.droppedForConfirm.join(", ")} MCP server(s) require per-call ` +
        "human approval, which this engine cannot provide — they are not available in this run. " +
        "If such an action is needed, describe the exact action and parameters in your output " +
        "for a human to execute."
    );
  }
  return parts.join("\n\n");
}

// ── Server pool ──────────────────────────────────────────────────────────────

interface OpencodeServerEntry {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  url: string;
  password: string;
  cwd: string;
  configHash: string;
  /** Stable per-server run-rpc token for the michael-* stdio proxies. */
  rpcToken: string;
  /** Stable per-server Meridian proxy API key (meridian-mode servers only) —
   *  reused across runs so the config hash (and thus the server) stays put. */
  meridianKey?: string;
  lastUsed: number;
  activeRuns: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const g = globalThis as any;
const servers: Map<string, OpencodeServerEntry> = (g.__opencodeServers ??= new Map());

// Active runs, keyed by run key + bks session id + opencode session id —
// mirrors activeCodexRuns (busy checks, cancellation, shutdown drain).
const activeOpencodeRuns: Map<string, AbortController> = (g.__activeOpencodeRuns ??= new Map());

export function isOpencodeSessionBusy(id: string): boolean {
  return activeOpencodeRuns.has(id);
}

export function activeOpencodeRunCount(): number {
  return activeOpencodeRuns.size;
}

export function cancelOpencodeRun(id: string): boolean {
  const ac = activeOpencodeRuns.get(id);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

/** Minimal env for the opencode server process (mirrors codexEnv). HOME is
 *  passed so OpenCode finds its own auth store (`opencode auth login`);
 *  backstage tokens never are. */
export function opencodeEnv(author?: GitIdentity | null): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME,
    LANG: process.env.LANG || "en_US.UTF-8",
    ...gitIdentityEnv(author),
  };
}

/** Stop every managed `opencode serve` process (verify scripts / tests, and
 *  the run-host's exit reap). Returns how many servers were told to die; await
 *  `awaitOpencodeServersDead` after when the caller is about to process.exit
 *  (the SIGKILL escalation is a timer that a fast exit would beat). */
export function killAllOpencodeServers(reason = "shutdown"): number {
  const entries = [...servers.entries()];
  const procs = entries.map(([, e]) => e.proc);
  for (const [key, entry] of entries) killServer(key, entry, reason);
  pendingKilled.push(...procs);
  return entries.length;
}

const pendingKilled: Subprocess<"ignore", "pipe", "pipe">[] = [];

/** Wait (bounded) for servers killed via killAllOpencodeServers to actually
 *  exit — covers the SIGTERM-swallowing meridian plugin, whose SIGKILL
 *  escalation fires KILL_ESCALATION_MS after the kill. */
export async function awaitOpencodeServersDead(timeoutMs = KILL_ESCALATION_MS + 3_000): Promise<void> {
  const waits = pendingKilled.splice(0).map((p) => p.exited);
  if (!waits.length) return;
  await Promise.race([
    Promise.all(waits),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Grace before SIGTERM escalates to SIGKILL: the meridian plugin installs
 *  SIGTERM/SIGINT handlers inside `opencode serve` that swallow the default
 *  terminate action (verified live 2026-07-08 — plain opencode exits on
 *  SIGTERM, a meridian-enabled one survives it), so every kill path escalates.
 *  Meridian itself is in-process and its Agent SDK children are per-request
 *  (none linger between turns — verified), so killing the server reaps the
 *  whole stack. */
const KILL_ESCALATION_MS = 5_000;

function killServer(key: string, entry: OpencodeServerEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const proc = entry.proc;
  try {
    proc.kill();
  } catch {}
  const escalate = setTimeout(() => {
    if (proc.exitCode === null) {
      console.warn(`[opencode-runner] server for ${key} ignored SIGTERM — escalating to SIGKILL`);
      try {
        proc.kill(9);
      } catch {}
    }
  }, KILL_ESCALATION_MS);
  (escalate as unknown as { unref?: () => void }).unref?.();
  void proc.exited.then(() => clearTimeout(escalate));
  servers.delete(key);
  console.log(`[opencode-runner] server for ${key} stopped (${reason})`);
}

function scheduleIdleKill(key: string): void {
  const entry = servers.get(key);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const cur = servers.get(key);
    if (!cur) return;
    if (cur.activeRuns > 0 || Date.now() - cur.lastUsed < IDLE_KILL_MS) {
      scheduleIdleKill(key);
      return;
    }
    killServer(key, cur, "idle");
  }, IDLE_KILL_MS + 1000);
}

async function spawnOpencodeServer(
  key: string,
  cwd: string,
  config: Record<string, unknown>,
  configHash: string,
  author?: GitIdentity | null,
  extraEnv?: Record<string, string>
): Promise<OpencodeServerEntry> {
  if (!existsSync(OPENCODE_BIN)) {
    throw new Error(
      `opencode binary not found at ${OPENCODE_BIN} — install it with \`npm i -g opencode-ai\` ` +
        "(or set BACKSTAGE_OPENCODE_BIN)."
    );
  }
  const password = crypto.randomUUID();
  const proc = Bun.spawn({
    cmd: [OPENCODE_BIN, "serve", "--hostname=127.0.0.1", "--port=0"],
    cwd,
    env: {
      ...opencodeEnv(author),
      ...(extraEnv || {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {}
      reject(new Error(`opencode serve didn't start within ${SERVER_START_TIMEOUT_MS / 1000}s: ${buf.slice(-500)}`));
    }, SERVER_START_TIMEOUT_MS);
    const scan = (chunk: string) => {
      if (settled) return;
      buf += chunk;
      const m = buf.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    // Keep draining both pipes for the server's lifetime — a full pipe would
    // block the process. Startup errors land in `buf` for the timeout message.
    const drain = (stream: ReadableStream<Uint8Array>) =>
      void (async () => {
        // Bun's ReadableStream is async-iterable at runtime; TS lib doesn't know.
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          scan(new TextDecoder().decode(chunk));
        }
      })().catch(() => {});
    drain(proc.stdout);
    drain(proc.stderr);
    void proc.exited.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited with code ${code}: ${buf.slice(-500)}`));
    });
  });

  const entry: OpencodeServerEntry = {
    proc,
    url,
    password,
    cwd,
    configHash,
    rpcToken: crypto.randomUUID(),
    lastUsed: Date.now(),
    activeRuns: 0,
  };
  servers.set(key, entry);
  scheduleIdleKill(key);
  console.log(`[opencode-runner] server for ${key} listening on ${url} (cwd ${cwd})`);
  return entry;
}

async function ensureOpencodeServer(
  key: string,
  cwd: string,
  config: Record<string, unknown>,
  author?: GitIdentity | null,
  extraEnv?: Record<string, string>
): Promise<OpencodeServerEntry> {
  // extraEnv is part of the identity: a different meridian account/token must
  // respawn the server (env only applies at spawn).
  const configHash = Bun.hash(
    JSON.stringify(config) + "\n" + cwd + "\n" + JSON.stringify(extraEnv || {})
  ).toString(16);
  const existing = servers.get(key);
  if (existing) {
    const alive = existing.proc.exitCode === null && !existing.proc.killed;
    if (alive && existing.configHash === configHash) return existing;
    killServer(key, existing, alive ? "config changed" : "process died");
  }
  return spawnOpencodeServer(key, cwd, config, configHash, author, extraEnv);
}

function clientFor(entry: OpencodeServerEntry): OpencodeClient {
  return createOpencodeClient({
    baseUrl: entry.url,
    headers: { Authorization: `Basic ${btoa(`opencode:${entry.password}`)}` },
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

function imageParts(images: ImageInput[] | undefined): Array<Record<string, unknown>> {
  return (images || []).map((im, i) => ({
    type: "file",
    mime: im.mediaType,
    filename: `image-${i + 1}`,
    url: `data:${im.mediaType};base64,${im.data}`,
  }));
}

/** Set by an attempt that hit a Claude usage limit on its meridian bridge
 *  account when another eligible account exists: the wrapper below reruns the
 *  turn once (the new account's env changes the server config hash, so a
 *  fresh opencode server binds to it). Mirrors claude-runner's
 *  rotate-after-limit. */
interface AccountRotation {
  rotate: boolean;
  note: string;
}

/** Rotation ceiling: enough to walk a realistic bridge-account pool, small
 *  enough that a pathological "usable but instantly capped" pool can't spin. */
const MAX_ACCOUNT_ATTEMPTS = 4;

export async function* runOpencode(
  opts: RunAgentOpts & { allowOpencode?: boolean },
  model: string
): AsyncGenerator<StreamEvent> {
  // Each attempt may request a rotation (usage-limit on its bridge account
  // while another usable account exists — the capped one is marked exhausted,
  // so the re-pick moves on). The final attempt runs without a rotation box
  // and thus ends in the terminal error (usageLimitExhausted ⇒ agent-runner's
  // model-fallback chain takes over).
  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const rotation: AccountRotation | undefined =
      attempt < MAX_ACCOUNT_ATTEMPTS - 1 ? { rotate: false, note: "" } : undefined;
    yield* runOpencodeAttempt(opts, model, rotation);
    if (!rotation?.rotate) return;
    yield { type: "text_chunk", text: `\n\n[runner] ${rotation.note}\n\n` };
  }
}

async function* runOpencodeAttempt(
  opts: RunAgentOpts & { allowOpencode?: boolean },
  model: string,
  rotation?: AccountRotation
): AsyncGenerator<StreamEvent> {
  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user, author } = opts;
  const isAsk = mode === "ask";

  const gateReason = opencodeGateReason(opts);
  if (gateReason) {
    audit({
      msg: "opencode_gate_denied",
      run_kind: journal?.kind,
      bks_session_id: journal?.bksSessionId,
      reason: gateReason,
    });
    yield { type: "error", content: gateReason, provider: PROVIDER, model };
    return;
  }

  const parsed = parseOpencodeModel(model);
  if (!parsed) {
    yield {
      type: "error",
      content: `Not an opencode model id: "${model}" (expected opencode/<provider>/<model>)`,
      provider: PROVIDER,
      model,
    };
    return;
  }

  const runKey = opts.sessionId || journal?.bksSessionId || crypto.randomUUID();
  if (activeOpencodeRuns.has(runKey)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }
  const abortController = new AbortController();
  const registeredKeys = new Set<string>([runKey]);
  if (journal?.bksSessionId) registeredKeys.add(journal.bksSessionId);
  for (const key of registeredKeys) activeOpencodeRuns.set(key, abortController);

  const serverKey = journal?.bksSessionId || cwd;
  const turnId = crypto.randomUUID();
  let ocSessionId = opts.sessionId || "";
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      provider: PROVIDER,
      turn_id: turnId,
      run_key: runKey,
      bks_session_id: journal?.bksSessionId,
      run_kind: journal?.kind,
      mode: mode || "code",
      claude_session_id: ocSessionId || undefined,
      model,
      ...fields,
    });

  let entry: OpencodeServerEntry | undefined;
  let rpcTokenRegistered = false;
  // Set by the proc-exit watcher / turn deadline; checked after the drain loop
  // so both failure modes surface as one clean error event.
  let runFailure: string | undefined;
  let runEnded = false;
  let failRun: () => void = () => {};
  // Run-level bridge audit closer (see module doc: subscription bridges —
  // meridian for anthropic, ChatGPT-OAuth for openai — audit per run, not per
  // HTTP request). First call wins; the finally backstop covers
  // cancellation/crashes.
  let bridgeRunEnd: (status: string, detail?: string) => void = () => {};
  // Liveness guard: subscription-bridge runs (meridian / openai) that hang at
  // an auth wall never produce output; the 60-min turn deadline is uselessly
  // long for that. When set, a run that emits nothing within LIVENESS_MS aborts
  // with a clear error. `bridgeAccountLabel` names the account in that error.
  let bridgeLivenessGuard = false;
  let bridgeAccountLabel = "";
  // Meridian-bridge account for this attempt (anthropic runs): rotation and
  // exhaustion-marking need the id, not just the display label.
  let pickedMeridian: ClaudeAccount | undefined;
  // The provider's most recent in-turn retry error (opencode retries stream
  // errors internally with backoff and stays silent while doing so — the
  // RetryPart / session.status events are the only visibility we get).
  let lastProviderRetryError = "";
  // The turn died on a Claude usage limit (weekly Fable cap, 5-hour session
  // limit, credits) — drives account rotation / usageLimitExhausted.
  let usageLimitHit = false;

  try {
    // Bridge for Anthropic models — dispatched on bridge.mode in
    // ~/.backstage-opencode.json; throws a clear config error when off.
    let providerOverride: Record<string, unknown> | undefined;
    let serverExtraEnv: Record<string, string> | undefined;
    let meridianPlugin: string[] | undefined;
    if (parsed.providerID === "anthropic") {
      const cfg = readOpencodeBridgeConfig();
      const bridgeMode = cfg?.enabled ? cfg.bridgeMode : "off";
      if (bridgeMode === "meridian") {
        const stack = meridianStackInfo();
        const picked = pickMeridianAccount(user, parsed.modelID, cfg!.bridgeAccountIds);
        if ("error" in picked) throw new Error(`meridian bridge: ${picked.error}`);
        // Stable per-server proxy key so the config hash — and the server —
        // survive across runs; a fresh key is minted only with a fresh server.
        const meridianKey = servers.get(serverKey)?.meridianKey || crypto.randomUUID();
        serverExtraEnv = meridianAccountEnv(picked, meridianKey);
        meridianPlugin = [stack.pluginPath];
        // The plugin rewrites baseURL to its live proxy URL at startup; the
        // placeholder guarantees a hard connection failure (never a real
        // Anthropic endpoint) if the plugin ever fails to load. apiKey is the
        // proxy key — Meridian requires it on every request.
        providerOverride = {
          anthropic: { options: { baseURL: "http://127.0.0.1:1", apiKey: meridianKey } },
        };
        const auditBase = {
          msg: "opencode_meridian_run",
          turn_id: turnId,
          run_key: runKey,
          bks_session_id: journal?.bksSessionId,
          run_kind: journal?.kind,
          model,
          account: picked.name,
          account_id: picked.id.slice(0, 8),
          meridian_version: stack.meridianVersion,
          plugin_version: stack.pluginVersion,
        };
        const startedAt = Date.now();
        audit({ ...auditBase, phase: "start" });
        let ended = false;
        bridgeRunEnd = (status, detail) => {
          if (ended) return;
          ended = true;
          audit({
            ...auditBase,
            phase: "end",
            status,
            duration_ms: Date.now() - startedAt,
            ...(detail ? { error: detail } : {}),
          });
        };
        bridgeLivenessGuard = true;
        bridgeAccountLabel = picked.name;
        pickedMeridian = picked;
      } else if (bridgeMode === "native") {
        const bridge = ensureAnthropicBridge();
        providerOverride = {
          anthropic: { options: { baseURL: `${bridge.url}/v1`, apiKey: bridge.key } },
        };
      } else {
        throw new Error(
          "opencode/anthropic/* models are disabled: ~/.backstage-opencode.json is missing, " +
            'has "enabled": false, or sets bridge.mode "off". Enable it with ' +
            '{"enabled": true} (bridge.mode defaults to "meridian") — or use an API-key ' +
            "provider configured via `opencode auth login` instead."
        );
      }
    } else if (parsed.providerID === "openai") {
      // opencode/openai/* on our EXISTING ChatGPT-subscription auth (the codex
      // accounts pool) — the OpenAI analog of the meridian bridge. Independent
      // of the anthropic bridge's `enabled` flag: it keys off codex-accounts,
      // not the bridge config (only the optional openaiAccounts restriction is
      // read there). With no codex accounts we fall through to opencode's own
      // host auth (`opencode auth login`) — unchanged behavior. See
      // opencode-openai-auth.ts for the seed-access-only rotation-hazard fix.
      const cfg = readOpencodeBridgeConfig();
      const picked = pickOpenaiAccount(parsed.modelID, cfg?.openaiAccounts);
      if (!("error" in picked)) {
        const bound = bindOpenaiAccount(picked);
        if ("error" in bound) throw new Error(`opencode/openai: ${bound.error}`);
        serverExtraEnv = { ...(serverExtraEnv || {}), ...bound.extraEnv };
        if (bound.providerOverride) providerOverride = bound.providerOverride;
        const auditBase = {
          msg: "opencode_openai_run",
          turn_id: turnId,
          run_key: runKey,
          bks_session_id: journal?.bksSessionId,
          run_kind: journal?.kind,
          model,
          account: maskOpenaiAccount(picked),
          account_id: picked.id.slice(0, 8),
          mechanism: bound.mechanism,
        };
        const startedAt = Date.now();
        audit({ ...auditBase, phase: "start" });
        let ended = false;
        bridgeRunEnd = (status, detail) => {
          if (ended) return;
          ended = true;
          audit({
            ...auditBase,
            phase: "end",
            status,
            duration_ms: Date.now() - startedAt,
            ...(detail ? { error: detail } : {}),
          });
        };
        // API-key runs authenticate synchronously (no OAuth wall to hang on);
        // guard only the subscription path where an auth hang is possible.
        if (bound.mechanism === "oauth-subscription") {
          bridgeLivenessGuard = true;
          bridgeAccountLabel = picked.name;
        }
      }
      // picked.error (no codex accounts) ⇒ fall through to opencode's own
      // host auth (`opencode auth login`) — but only when that credential
      // actually exists. Without it opencode simply omits the provider from
      // its generated config and the turn dies with a bare "model not found";
      // say what's actually wrong instead. (In a sandbox this means the
      // ChatGPT/codex account files aren't mounted — containers created
      // before the mount fix need recreation.)
      if ("error" in picked && !opencodeHasNativeOpenaiAuth()) {
        throw new Error(
          `opencode/openai: ${picked.error}; and no native \`opencode auth login\` openai ` +
            "credential exists in this environment. In a sandbox, the ChatGPT/codex account " +
            "files may not be mounted into the container (recreate the sandbox on current " +
            "code); otherwise add a codex account in Connections."
        );
      }
    }

    const { mcp: externalMcp, droppedForConfirm } = buildOpencodeMcpConfig(
      mcpServers,
      user,
      confirmTools
    );

    // Instructions file (OpenCode's system-append channel). Rewritten per run
    // (repos can attach mid-session); the stable path keeps the config hash —
    // and therefore the server — unchanged.
    mkdirSync(OPENCODE_STATE_DIR, { recursive: true });
    const instructionsPath = `${OPENCODE_STATE_DIR}/${serverKey.replace(/[^A-Za-z0-9._-]/g, "_")}-instructions.md`;
    const instructions = buildOpencodeInstructions({
      isAsk,
      reposNote: opts.reposNote,
      inProcessMcp: opts.inProcessMcp,
      bksSessionId: journal?.bksSessionId,
      droppedForConfirm,
    });
    writeFileSync(instructionsPath, instructions || "");

    // Stable per-server rpc token: minted with the server entry, registered
    // for the duration of each run (the proxies only forward during runs).
    const preEntry = servers.get(serverKey);
    const rpcToken = preEntry?.rpcToken || crypto.randomUUID();
    const hasInProcess = !!(opts.inProcessMcp && Object.keys(opts.inProcessMcp).length);
    // Prebuilt stdio proxies (runner-host context) pass through as-is — their
    // rpc token is already registered in the backstage process. See
    // opencodeMcpFromPrebuiltProxies.
    const prebuiltProxies = opencodeMcpFromPrebuiltProxies(opts.inProcessMcp);

    const ocConfig: Record<string, unknown> = {
      mcp: {
        ...externalMcp,
        ...(prebuiltProxies ??
          (hasInProcess && journal?.bksSessionId
            ? proxyOpencodeMcpConfigs(opts.inProcessMcp, rpcToken)
            : {})),
      },
      instructions: [instructionsPath],
      autoshare: false,
      ...(meridianPlugin ? { plugin: meridianPlugin } : {}),
      ...(providerOverride ? { provider: providerOverride } : {}),
      ...(isAsk
        ? {
            permission: {
              edit: "deny",
              bash: ASK_BASH_PERMISSIONS,
              webfetch: "allow",
              external_directory: "deny",
            },
            tools: { write: false, edit: false, patch: false },
          }
        : {}),
    };

    entry = await ensureOpencodeServer(serverKey, cwd, ocConfig, author, serverExtraEnv);
    entry.rpcToken = rpcToken;
    if (serverExtraEnv?.MERIDIAN_API_KEY) entry.meridianKey = serverExtraEnv.MERIDIAN_API_KEY;
    entry.activeRuns++;
    entry.lastUsed = Date.now();

    // Watch the server process for the duration of this run: a mid-turn death
    // would otherwise leave the SSE pump reconnecting forever and the drain
    // loop blocked on `wake` — holding the session busy indefinitely.
    {
      const watched = entry;
      void watched.proc.exited.then((code) => {
        if (runEnded) return;
        runFailure ??= `opencode serve exited mid-run (code ${code}) — the turn was lost; send the prompt again to restart on a fresh server`;
        if (servers.get(serverKey) === watched) killServer(serverKey, watched, "died mid-run");
        failRun();
      });
    }
    if (!prebuiltProxies && hasInProcess && journal?.bksSessionId) {
      registerRunToken(rpcToken, { sessionId: journal.bksSessionId, user });
      rpcTokenRegistered = true;
    }

    const client = clientFor(entry);

    // Resolve/create the opencode session.
    let createdFresh = false;
    if (ocSessionId) {
      const existing = await client.session.get({ path: { id: ocSessionId } });
      if (!existing.data) {
        console.warn(`[opencode-runner] Session ${ocSessionId} not found — starting fresh`);
        ocSessionId = "";
      }
    }
    if (!ocSessionId) {
      const created = await client.session.create({
        body: { title: journal?.bksSessionId ? `backstage ${journal.bksSessionId}` : "backstage run" },
      });
      if (!created.data) throw new Error(`Failed to create opencode session: ${JSON.stringify(created.error ?? "")}`);
      ocSessionId = created.data.id;
      createdFresh = true;
    }
    if (!registeredKeys.has(ocSessionId)) {
      registeredKeys.add(ocSessionId);
      activeOpencodeRuns.set(ocSessionId, abortController);
    }

    // Persist this run to the session's claude-shape jsonl transcript file —
    // OpenCode's own storage is SQLite (nothing tailable), and without a file
    // every reload rendered "No transcript available". Fresh cross-engine
    // handoffs seed the file with the prior engine's history; legacy sessions
    // (runs from before persistence existed) backfill from SQLite here.
    ensureOpencodeTranscriptFile(
      ocSessionId,
      createdFresh ? opts.seedTranscriptEntries : undefined
    );
    appendOpencodeTranscript(ocSessionId, [transcriptLineUser(prompt)]);

    if (journal) {
      journalSet({
        runKey,
        bksSessionId: journal.bksSessionId,
        claudeSessionId: ocSessionId,
        prompt,
        cwd,
        mode,
        mcpServers,
        user,
        confirmTools,
        aws: false,
        model,
        effort: opts.effort,
        fallbackModel: opts.fallbackModel,
        kind: journal.kind,
        startedAt: new Date().toISOString(),
      });
    }

    turnEvent({
      direction: "in",
      kind: "user_prompt",
      cwd,
      mcp_servers: mcpServers,
      ...summarizeText(prompt),
    });
    yield { type: "init", sessionId: ocSessionId, provider: PROVIDER, model };

    // Abort → tell the server to stop the turn (best-effort), our loops exit
    // on the signal.
    abortController.signal.addEventListener("abort", () => {
      void client.session.abort({ path: { id: ocSessionId } }).catch(() => {});
    });

    // ── Event pump: SSE → StreamEvents, with reconnect (Bun's fetch aborts
    // responses idle >300s; quiet stretches during long tool calls hit that).
    const pending: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    let idle = false; // session went idle = turn finished
    let sessionError: string | undefined;
    const emittedText = new Set<string>();
    const startedTools = new Set<string>();
    const finishedTools = new Set<string>();
    let sawFirstOutput = false;
    const push = (ev: StreamEvent) => {
      sawFirstOutput = true;
      pending.push(ev);
      wake?.();
    };
    const signalDone = () => {
      idle = true;
      wake?.();
    };
    failRun = signalDone;

    // opencode retries provider stream errors internally (exponential backoff,
    // silent from the outside) — RetryPart / session.status "retry" events are
    // the only in-turn visibility. Record the error for the liveness guard's
    // message, and fail FAST on a Claude usage limit: retrying the same capped
    // account can never succeed, so waiting out the 90s guard (with a
    // misleading "authentication hang" message) just burns the user's time.
    const noteProviderRetry = (attempt: number, message: string) => {
      if (!message) return;
      lastProviderRetryError = message;
      turnEvent({
        direction: "out",
        kind: "provider_retry",
        retry_attempt: attempt,
        error: message.slice(0, 500),
      });
      if (
        parsed.providerID === "anthropic" &&
        pickedMeridian &&
        !runFailure &&
        isClaudeUsageLimitError(message, true)
      ) {
        usageLimitHit = true;
        runFailure =
          `Claude usage limit on account "${bridgeAccountLabel}": ${message.slice(0, 300)}`;
        void client.session.abort({ path: { id: ocSessionId } }).catch(() => {});
        signalDone();
      }
    };

    const handleEvent = async (ev: any) => {
      const p = ev?.properties;
      switch (ev?.type) {
        case "message.part.updated": {
          const part = p?.part;
          if (!part || part.sessionID !== ocSessionId) return;
          if (part.type === "retry") {
            noteProviderRetry(
              Number(part.attempt) || 0,
              String(part.error?.data?.message || part.error?.name || "")
            );
            return;
          }
          if (part.type === "text" && !part.synthetic && part.time?.end && !emittedText.has(part.id)) {
            emittedText.add(part.id);
            turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(part.text) });
            appendOpencodeTranscript(ocSessionId, [
              transcriptLineAssistantText(part.text, part.id),
            ]);
            push({ type: "text_chunk", text: part.text });
          }
          if (part.type === "reasoning" && part.time?.end && !emittedText.has(part.id)) {
            emittedText.add(part.id);
            turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(part.text) });
          }
          if (part.type === "tool") {
            const state = part.state;
            if ((state?.status === "running" || state?.status === "completed" || state?.status === "error") && !startedTools.has(part.id)) {
              startedTools.add(part.id);
              turnEvent({
                direction: "out",
                kind: "tool_use",
                tool_name: part.tool,
                tool_use_id: part.id,
                ...summarizeText(JSON.stringify(state?.input ?? {}), 500),
              });
              appendOpencodeTranscript(ocSessionId, [
                transcriptLineToolUse(part.id, part.tool || "tool", state?.input),
              ]);
              push({ type: "tool_use", toolName: part.tool, toolInput: state?.input, toolUseId: part.id });
            }
            if ((state?.status === "completed" || state?.status === "error") && !finishedTools.has(part.id)) {
              finishedTools.add(part.id);
              const result = state.status === "completed" ? state.output || "" : `Error: ${state.error}`;
              turnEvent({
                direction: "in",
                kind: "tool_result",
                tool_use_id: part.id,
                is_error: state.status === "error",
                ...summarizeText(result),
              });
              appendOpencodeTranscript(ocSessionId, [
                transcriptLineToolResult(part.id, result, state.status === "error"),
              ]);
              push({
                type: "tool_result",
                toolUseId: part.id,
                content: result.length > 500 ? result.slice(0, 500) + "..." : result,
              });
            }
          }
          return;
        }
        case "permission.updated": {
          if (p?.sessionID !== ocSessionId) return;
          // No interactive permission bridge on this engine yet — reject, so a
          // misconfigured "ask" can never wedge or silently allow.
          turnEvent({
            direction: "out",
            kind: "permission_decision",
            tool_name: p?.type,
            decision: "deny",
            reason: "opencode_no_permission_bridge",
          });
          try {
            await client.postSessionIdPermissionsPermissionId({
              path: { id: ocSessionId, permissionID: p.id },
              body: { response: "reject" },
            });
          } catch (e) {
            console.warn("[opencode-runner] failed to reject permission ask:", e);
          }
          return;
        }
        case "session.error": {
          if (p?.sessionID && p.sessionID !== ocSessionId) return;
          const err = p?.error;
          sessionError = err?.data?.message || err?.name || "opencode session error";
          return;
        }
        case "session.status": {
          // Belt-and-braces sibling of the RetryPart handler (older/newer
          // servers may emit one or both shapes).
          if (p?.sessionID !== ocSessionId) return;
          const st = p?.status;
          if (st?.type === "retry") {
            noteProviderRetry(Number(st.attempt) || 0, String(st.message || ""));
          }
          return;
        }
        case "session.idle": {
          if (p?.sessionID === ocSessionId) signalDone();
          return;
        }
      }
    };

    let pumpStopped = false;
    const pump = (async () => {
      while (!pumpStopped && !abortController.signal.aborted && !idle) {
        try {
          const sub = await client.event.subscribe();
          for await (const ev of sub.stream as AsyncGenerator<any>) {
            if (pumpStopped || abortController.signal.aborted) return;
            await handleEvent(ev);
            if (idle) return;
          }
        } catch {
          // stream dropped — fall through to reconnect
        }
        if (!pumpStopped && !idle && !abortController.signal.aborted) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();

    // Fire the prompt without holding an HTTP response open for the whole
    // turn (prompt_async returns 204 immediately; completion arrives as
    // session.idle — with a status poll as the SSE-gap fallback).
    const sent = await client.session.promptAsync({
      path: { id: ocSessionId },
      body: {
        model: parsed,
        parts: [{ type: "text", text: prompt }, ...(imageParts(opts.images) as any[])],
      },
    });
    if (sent.error) {
      throw new Error(`opencode prompt failed: ${JSON.stringify(sent.error)}`);
    }
    const sentAt = Date.now();

    // Hard per-turn wall-clock deadline (default 60 min, turnTimeoutMinutes in
    // ~/.backstage-opencode.json): a turn that never goes idle — model loop,
    // server wedge the exit watcher can't see — ends with a clear error
    // instead of holding the session busy forever.
    const turnTimeout = opencodeTurnTimeoutMs();
    const turnDeadline = setTimeout(() => {
      runFailure ??=
        `opencode turn exceeded the ${Math.round(turnTimeout / 60_000)}-minute wall-clock limit ` +
        "(turnTimeoutMinutes in ~/.backstage-opencode.json) — aborting the turn";
      void client.session.abort({ path: { id: ocSessionId } }).catch(() => {});
      signalDone();
    }, turnTimeout);

    // Liveness guard (subscription-bridge runs only): an auth hang produces no
    // output at all, and the 60-min turn deadline is uselessly long for it. If
    // nothing has streamed within LIVENESS_MS, abort with a clear error naming
    // the account, rather than holding the session busy for an hour.
    const LIVENESS_MS = 90_000;
    const livenessTimer = bridgeLivenessGuard
      ? setTimeout(() => {
          if (sawFirstOutput || idle || abortController.signal.aborted) return;
          // Name the real cause when the provider told us (captured retry
          // errors) instead of guessing "authentication hang".
          if (lastProviderRetryError && isClaudeUsageLimitError(lastProviderRetryError, true)) {
            usageLimitHit = true;
          }
          runFailure ??= lastProviderRetryError
            ? `opencode ${parsed.providerID} run produced no output within ${LIVENESS_MS / 1000}s — ` +
              `the provider kept retrying on account "${bridgeAccountLabel}": ` +
              `${lastProviderRetryError.slice(0, 300)}; aborting`
            : `opencode ${parsed.providerID} run produced no output within ${LIVENESS_MS / 1000}s — ` +
              `likely an authentication hang on account "${bridgeAccountLabel}"; aborting`;
          void client.session.abort({ path: { id: ocSessionId } }).catch(() => {});
          signalDone();
        }, LIVENESS_MS)
      : undefined;

    const statusPoll = setInterval(() => {
      void (async () => {
        try {
          if (!entry || idle) return;
          // Grace: right after send the status map may not list the session
          // as busy yet — only trust absent/idle once the turn is clearly on.
          if (Date.now() - sentAt < 15_000) return;
          const res = await clientFor(entry).session.status({});
          const statuses = res.data as Record<string, { type?: string }> | undefined;
          const mine = statuses?.[ocSessionId];
          // Absent or idle ⇒ the turn ended (covers an SSE gap that ate the
          // idle event).
          if (!mine || mine.type === "idle") signalDone();
        } catch {}
      })();
    }, 10_000);

    try {
      // Drain mapped events until the session goes idle (or abort/error).
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (abortController.signal.aborted) return;
        if (idle) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      while (pending.length) yield pending.shift()!;
    } finally {
      clearInterval(statusPoll);
      clearTimeout(turnDeadline);
      if (livenessTimer) clearTimeout(livenessTimer);
      pumpStopped = true;
      void pump.catch(() => {});
    }

    // Server died or the turn deadline hit — surface the clean error (the
    // final-message fetch below would just throw a raw fetch error on a dead
    // server) and let the finally cleanup release the session.
    if (runFailure) {
      // Claude usage limit on the meridian account: sideline it (model-scoped
      // for credit-metered models like Fable — see markExhausted) and, when
      // another eligible account exists, ask the wrapper for one retry on it
      // instead of failing the turn. No account left ⇒ terminal error with
      // usageLimitExhausted so agent-runner's model fallback takes over.
      if (usageLimitHit && pickedMeridian) {
        markExhausted(pickedMeridian.id, parsed.modelID);
        if (rotation) {
          const next = pickMeridianAccount(
            user,
            parsed.modelID,
            readOpencodeBridgeConfig()?.bridgeAccountIds
          );
          if (!("error" in next)) {
            turnEvent({ direction: "out", kind: "account_switch", account: next.name });
            bridgeRunEnd("error", runFailure);
            rotation.rotate = true;
            rotation.note =
              `Claude usage limit hit on account "${pickedMeridian.name}" ` +
              `(${parsed.modelID}); switched to "${next.name}" and retrying.`;
            return;
          }
        }
        runFailure +=
          " — no other account is currently usable for this model; use /model to switch models.";
      }
      turnEvent({ direction: "out", kind: "error", error: runFailure });
      bridgeRunEnd("error", runFailure);
      yield {
        type: "error",
        content: runFailure,
        provider: PROVIDER,
        model,
        usageLimitExhausted: usageLimitHit || undefined,
      };
      return;
    }

    // Turn finished — read the authoritative final assistant message.
    const msgs = await client.session.messages({ path: { id: ocSessionId } });
    const list = (msgs.data || []) as Array<{ info: any; parts: any[] }>;
    const lastAssistant = [...list].reverse().find((m) => m.info?.role === "assistant");
    const info = lastAssistant?.info;
    const parts = lastAssistant?.parts || [];
    const textOut = parts
      .filter((pt) => pt.type === "text" && !pt.synthetic && pt.text)
      .map((pt) => {
        if (!emittedText.has(pt.id)) {
          emittedText.add(pt.id);
          appendOpencodeTranscript(ocSessionId, [
            transcriptLineAssistantText(pt.text, pt.id),
          ]);
          pending.push({ type: "text_chunk", text: pt.text });
        }
        return pt.text;
      })
      .join("\n\n");
    while (pending.length) yield pending.shift()!;

    const errMessage =
      sessionError ||
      (info?.error ? info.error?.data?.message || info.error?.name : undefined);
    if (errMessage && info?.error?.name !== "MessageAbortedError") {
      const limit =
        parsed.providerID === "anthropic"
          ? isClaudeUsageLimitError(errMessage, true)
          : isCodexUsageLimitError(errMessage);
      turnEvent({ direction: "out", kind: "error", error: errMessage });
      bridgeRunEnd("error", errMessage);
      yield {
        type: "error",
        content: errMessage,
        provider: PROVIDER,
        model,
        usageLimitExhausted: limit || undefined,
      };
      return;
    }
    if (abortController.signal.aborted) return;

    const tokens = info?.tokens;
    turnEvent({
      direction: "out",
      kind: "result",
      result_subtype: "success",
      is_error: false,
      input_tokens: tokens?.input,
      output_tokens: tokens?.output,
      cache_read_input_tokens: tokens?.cache?.read,
      total_cost_usd: info?.cost,
      ...summarizeText(textOut),
    });
    bridgeRunEnd("success");
    yield {
      type: "done",
      sessionId: ocSessionId,
      result: textOut || "Done! (no text output)",
      provider: PROVIDER,
      model,
      usage: tokens
        ? {
            costUsd: info?.cost || undefined,
            costApproximate: true,
            inputTokens: tokens.input || 0,
            outputTokens: tokens.output || 0,
            cacheReadTokens: tokens.cache?.read || 0,
            cacheCreationTokens: tokens.cache?.write || 0,
            contextTokens:
              (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0),
          }
        : undefined,
    };
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      const message = e?.message || String(e);
      turnEvent({ direction: "out", kind: "error", error: message });
      bridgeRunEnd("error", message);
      yield {
        type: "error",
        content: message,
        provider: PROVIDER,
        model,
        usageLimitExhausted:
          (parsed.providerID === "anthropic"
            ? isClaudeUsageLimitError(message, true)
            : isCodexUsageLimitError(message)) || undefined,
      };
    }
  } finally {
    runEnded = true;
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    // Backstop for paths that never reached an explicit close (cancel, early
    // return, generator torn down mid-drain) — no-op if already ended.
    bridgeRunEnd(abortController.signal.aborted ? "cancelled" : "abandoned");
    for (const key of registeredKeys) activeOpencodeRuns.delete(key);
    if (rpcTokenRegistered && entry) unregisterRunToken(entry.rpcToken);
    if (entry) {
      entry.activeRuns = Math.max(0, entry.activeRuns - 1);
      entry.lastUsed = Date.now();
    }
    // Keep the journal across an account-rotation retry (the wrapper reruns
    // the same runKey immediately); cleared for real on the final attempt.
    if (journal && !rotation?.rotate) journalClear(runKey);
  }
}
