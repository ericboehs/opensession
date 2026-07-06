import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { getAgentAwsEnv } from "./aws-creds";
import { audit, summarizeText } from "./audit";
import {
  pickAccount,
  getUsableAccountById,
  markExhausted,
  type ClaudeAccount,
} from "./claude-accounts";
import { cleanPlainToolInput } from "./shared/note-style";
import { writeJsonAtomic } from "./shared/atomic-write";
import { gitIdentityEnv, userMatchesAny, type GitIdentity } from "./shared/user-mappings";
import { getDefaultModel, hasPricing, priceUsageUsd } from "./models";

const HOME = process.env.HOME || "/home/ubuntu";
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const CLAUDE_DIR = `${HOME}/.claude`;
const CLAUDE_CREDENTIALS_PATH = `${CLAUDE_DIR}/.credentials.json`;
const CLAUDE_ACCOUNTS_DIR = `${CLAUDE_DIR}/accounts`;
const CLAUDE_ACTIVE_ACCOUNT_PATH = `${CLAUDE_ACCOUNTS_DIR}/.active`;

/**
 * Token/cost accounting for a single run (accumulated across all turns in the
 * run — steers and background-task follow-ups included), attached to the
 * terminal `done` event. `costUsd` is authoritative for Claude (the SDK's
 * `total_cost_usd`) and computed from the rate table for Codex (`costApproximate`
 * then true). `contextTokens` is the last turn's full prompt size (input + cache
 * read + cache creation) — the live "how full is the context window" figure.
 */
export interface TurnUsage {
  costUsd?: number;
  costApproximate?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number;
}

export interface StreamEvent {
  type:
    | "init"
    | "text_chunk"
    | "tool_use"
    | "tool_result"
    | "done"
    | "error"
    | "model_switch";
  sessionId?: string;
  text?: string;
  /** On a model_switch: the exhausted model and the fallback it switched to. */
  fromModel?: string;
  toModel?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  result?: string;
  /**
   * Renderable image sources on a tool_result (data: URLs from base64 blocks,
   * or direct urls). Forwarded to viewers so screenshots show up the moment
   * the tool returns instead of waiting for the jsonl tail to catch up.
   */
  images?: string[];
  /**
   * Renderable video sources on a tool_result, parsed from `BACKSTAGE_VIDEO:`
   * markers in the (full, pre-truncation) tool output. Forwarded so recordings
   * play the moment the tool returns, no reload needed.
   */
  videos?: string[];
  /** Which backend emitted this event (set on init/done). */
  provider?: "claude" | "codex";
  /** Effective model for the run (set on init/done). */
  model?: string;
  /** Cumulative token/cost accounting for the run (set on the terminal done). */
  usage?: TurnUsage;
  /**
   * Set on a terminal done/error when the run died on usage limits with no
   * account left to rotate to — the dispatcher's cue to try a fallback model.
   */
  usageLimitExhausted?: boolean;
}

// Track active runs to prevent concurrent runs on same session. Parked on
// globalThis so a `bun --hot` reload of this module keeps existing runs
// steerable/cancelable (and countable for graceful shutdown).
const activeRuns: Map<string, AbortController> = ((globalThis as any).__activeClaudeRuns ??=
  new Map());

/** Number of Claude runs this process is actively driving (for shutdown drain). */
export function activeRunCount(): number {
  return activeRuns.size;
}

// Minimal environment for the spawned Claude process. Backstage's own env
// carries every API token and webhook secret from ~/.backstage.env; the agent
// child needs none of those — MCP servers get their credentials via
// mcp-config.json's per-server `env` (or load it themselves, like the
// workos-mcp wrapper). Only pass what the child needs to launch and run.
//
// `awsEnv` (optional) carries short-lived AWS credentials minted for this run;
// see aws-creds.ts. The child can't reach IMDS (cgroup deny), so these injected
// vars are its only AWS access.
function childEnv(
  awsEnv?: Record<string, string>,
  oauthToken?: string,
  author?: GitIdentity | null
): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    MICHAEL_MODEL: process.env.MICHAEL_MODEL,
    // Attribute commits this run makes to the user who sent the prompt (empty for
    // unknown/automation authors → keeps the machine's default git identity).
    ...gitIdentityEnv(author),
    // Account-pool token (claude-accounts.ts). Beats ~/.claude/.credentials.json
    // in the CLI's auth precedence, so runs rotate accounts without touching
    // the interactive CLI's login.
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    ...awsEnv,
  };
}

// `strict` matching applies to successful results too — the CLI reports usage
// limits as a plain result text ("Claude AI usage limit reached|<ts>",
// "5-hour limit reached ∙ resets …"), with subtype "success". The looser
// heuristic only applies to error results, where false positives can't
// clobber a legitimate answer.
export function isClaudeUsageLimitError(message: string, isErrorResult: boolean): boolean {
  const s = message.toLowerCase();
  // Observed CLI phrasings: "You've hit your session limit · resets 12:50pm (UTC)",
  // "Claude AI usage limit reached|<ts>", "5-hour limit reached ∙ resets 3am"
  if (/you've hit your .{0,20}limit/.test(s)) return true;
  // Credit-metered premium models (e.g. Fable 5) exhaust a separate per-account
  // credit pool, not the 5-hour session limit, and say so with none of the
  // "limit/reached/resets" tokens: "You're out of usage credits. Run
  // /usage-credits to keep using Fable 5 or /model to switch models." Treat it
  // as a usage limit so the run rotates to another account (each has its own
  // credit balance) and, once the pool is drained, falls back off the model.
  if (/out of (usage )?credits/.test(s) || s.includes("/usage-credits")) return true;
  if (/claude (ai )?usage limit reached/.test(s)) return true;
  if (/limit (reached|hit).{0,60}resets/.test(s)) return true;
  // Short result that is just a limit notice, whatever the exact phrasing
  if (s.length < 200 && /\blimit\b/.test(s) && /\bresets\b/.test(s)) return true;
  if (!isErrorResult) return false;
  if (s.includes("rate_limit_error") || s.includes("429") || s.includes("too many requests")) return true;
  return (
    (s.includes("usage") || s.includes("rate") || s.includes("limit")) &&
    (s.includes("exceeded") || s.includes("reached"))
  );
}

function listSavedClaudeAccounts(): string[] {
  if (!existsSync(CLAUDE_ACCOUNTS_DIR)) return [];
  return readdirSync(CLAUDE_ACCOUNTS_DIR).filter((name) => {
    if (name.startsWith(".")) return false;
    return existsSync(`${CLAUDE_ACCOUNTS_DIR}/${name}/credentials.json`);
  });
}

function readActiveClaudeAccount(): string | undefined {
  try {
    return existsSync(CLAUDE_ACTIVE_ACCOUNT_PATH)
      ? readFileSync(CLAUDE_ACTIVE_ACCOUNT_PATH, "utf-8").trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function switchClaudeAccountAfterLimit(): string | undefined {
  const preferred = process.env.CLAUDE_FALLBACK_PROFILE;
  const active = readActiveClaudeAccount();
  const accounts = listSavedClaudeAccounts();
  const next = preferred && preferred !== active && accounts.includes(preferred)
    ? preferred
    : accounts.find((name) => name !== active);

  if (!next) return undefined;

  mkdirSync(`${CLAUDE_DIR}/backups`, { recursive: true });
  if (existsSync(CLAUDE_CREDENTIALS_PATH)) {
    copyFileSync(
      CLAUDE_CREDENTIALS_PATH,
      `${CLAUDE_DIR}/backups/credentials-before-auto-switch-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}.json`
    );
  }
  copyFileSync(`${CLAUDE_ACCOUNTS_DIR}/${next}/credentials.json`, CLAUDE_CREDENTIALS_PATH);
  writeFileSync(CLAUDE_ACTIVE_ACCOUNT_PATH, `${next}\n`);
  console.warn(`[runner] Claude usage limit hit on ${active || "unknown"}; switched credentials to ${next}`);
  return next;
}

/**
 * Resolve the MCP servers for a run: all configured, or just the allowlist,
 * minus any server whose per-user `allowedUsers` list excludes `user`. The
 * `allowedUsers` field is stripped from every entry before it reaches the SDK
 * (it's our metadata, not MCP config).
 */
export function filterMcpServers(
  allowlist?: string[],
  user?: string
): Record<string, unknown> {
  const all = withDynamicCredentials(readMcpConfig().mcpServers);
  const out: Record<string, unknown> = {};
  const names = allowlist ?? Object.keys(all);
  for (const name of names) {
    const cfg = all[name] as any;
    if (!cfg) {
      if (allowlist) console.warn(`[runner] MCP allowlist names unknown server "${name}" — skipping`);
      continue;
    }
    const { allowedUsers, ...entry } = cfg;
    if (Array.isArray(allowedUsers) && allowedUsers.length && !userMatchesAny(user, allowedUsers)) {
      // User-restricted server this run's user isn't cleared for — hide it.
      continue;
    }
    out[name] = entry;
  }
  return out;
}

// ── Crash/restart journal ────────────────────────────────────
// Every in-flight run is recorded on disk; entries that survive a process
// restart are interrupted runs, which backstage resumes on boot.

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
const ACTIVE_RUNS_PATH =
  process.env.BACKSTAGE_RUN_JOURNAL || `${BACKSTAGE_CHATS_DIR}/active-runs.json`;

/** Backstage web UI base — used to give a session a link back to itself. */
const UI_BASE =
  process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

export interface ActiveRunRecord {
  runKey: string;
  bksSessionId?: string;
  claudeSessionId?: string; // claude session id or codex thread id, per model's provider
  prompt?: string; // original prompt — lets a run interrupted before it got an engine session be re-run from scratch (safe: no session id ⇒ no model output ⇒ no side effects yet)
  cwd: string;
  mode?: "ask" | "code";
  mcpServers?: string[]; // per-run MCP allowlist, preserved across resume
  user?: string; // per-run user, preserved across resume (gates per-user MCP servers)
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
  confirmTools?: Record<string, string>; // per-run human-confirmed tools, preserved across resume
  aws?: boolean; // whether to inject AWS creds, preserved across resume
  model?: string; // per-session model, preserved across resume (decides the provider)
  accountId?: string; // pinned Claude subscription, preserved across resume
  fallbackModel?: string; // usage-limit fallback policy, preserved across resume
  kind?: string;
  startedAt: string;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    return existsSync(ACTIVE_RUNS_PATH)
      ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
      : {};
  } catch {
    return {};
  }
}

function writeRunJournal(journal: Record<string, ActiveRunRecord>): void {
  try {
    writeJsonAtomic(ACTIVE_RUNS_PATH, journal);
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

export function journalSet(record: ActiveRunRecord): void {
  const journal = readRunJournal();
  journal[record.runKey] = record;
  writeRunJournal(journal);
}

export function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Snapshot of the runs currently journaled as in-flight (does not clear). */
export function activeRunRecords(): ActiveRunRecord[] {
  return Object.values(readRunJournal());
}

/** Drain interrupted runs left by a previous process (clears the journal). */
export function takeInterruptedRuns(): ActiveRunRecord[] {
  const journal = readRunJournal();
  const entries = Object.values(journal).filter(
    (r) => !activeRuns.has(r.runKey)
  );
  if (entries.length > 0) writeRunJournal({});
  return entries;
}

export function isSessionBusy(sessionId: string): boolean {
  // Check if we have an active run
  if (activeRuns.has(sessionId)) return true;

  // Check if another CLI process is running this session
  if (!existsSync(CLI_SESSIONS_DIR)) return false;
  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(`${CLI_SESSIONS_DIR}/${file}`, "utf-8"));
      if (data.sessionId === sessionId) {
        try {
          process.kill(data.pid, 0);
          return true; // PID alive
        } catch {
          // PID dead
        }
      }
    } catch {}
  }
  return false;
}

export function cancelRun(sessionId: string): boolean {
  const ac = activeRuns.get(sessionId);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

// ── Steering ─────────────────────────────────────────────────
// In-flight runs accept extra user messages, Claude-Code style: a message
// arriving mid-turn is merged into the running turn by the SDK; one arriving
// at a turn boundary starts a fresh turn in the same run. Keyed by every id a
// caller might know (run key, engine session id, backstage session id).
// Parked on globalThis alongside activeRuns: a `bun --hot` reload re-evaluates
// this module, and a run started before the reload keeps executing off its old
// closures. If these maps reset to empty, steerRun/interruptAndSteerRun from the
// reloaded module can't find the live run's controllers and return false — the
// caller then falls back to the slow promptQueues poller (drains only when the
// whole run ends) instead of folding the message in at the next turn boundary.
const steerControllers: Map<
  string,
  (text: string, images?: ImageInput[]) => void
> = ((globalThis as any).__steerControllers ??= new Map());
const interrupters: Map<string, () => void> = ((globalThis as any).__interrupters ??=
  new Map());
// How many steered messages a run is still holding (unreleased). Lets the bare
// interruptRun refuse to fire when there's nothing to release — interrupting
// then would abort live work and end the run instead of fast-forwarding a steer.
const pendingSteerProbes: Map<string, () => number> = ((globalThis as any)
  .__pendingSteerProbes ??= new Map());
// Discard a run's unreleased steers (returns how many were dropped). The
// Esc-style stop uses this so the forced boundary winds the run down instead
// of delivering the held messages; the caller requeues their receipts.
const steerDiscarders: Map<string, () => number> = ((globalThis as any)
  .__steerDiscarders ??= new Map());

/**
 * Deliver a message into a running query. False = no steerable run found.
 * Pasted/dropped images ride along as content blocks (same shape as the
 * opening message), released at the next turn boundary.
 */
export function steerRun(
  sessionId: string,
  text: string,
  images?: ImageInput[],
): boolean {
  const push = steerControllers.get(sessionId);
  if (!push) return false;
  push(text, images);
  return true;
}

/**
 * Bare Esc-style interrupt: abort the current turn (the session and the query
 * survive) WITHOUT adding a message — the resulting turn boundary immediately
 * releases whatever is already waiting in the run's steer buffer. Used by the
 * queue flap's Interrupt on an already-steered message (pushing its text again
 * would deliver it twice). False = no interruptible run found.
 */
export function interruptRun(sessionId: string): boolean {
  const interrupt = interrupters.get(sessionId);
  const pendingSteers = pendingSteerProbes.get(sessionId);
  if (!interrupt || !pendingSteers || pendingSteers() === 0) return false;
  interrupt();
  return true;
}

/**
 * Esc-style stop: discard any unreleased steered messages, then abort the
 * current turn. With nothing held, the forced boundary winds the run down
 * gracefully (clean transcript, normal process exit) instead of the hard
 * abort cancelRun does. False = no interruptible Claude run found.
 */
export function stopRunTurn(sessionId: string): boolean {
  const interrupt = interrupters.get(sessionId);
  if (!interrupt) return false;
  steerDiscarders.get(sessionId)?.();
  interrupt();
  return true;
}

/**
 * Esc-style redirect: abort the current turn (graceful — the session and the
 * query survive) and continue immediately with the given message as the next
 * turn. False = no interruptible run found.
 */
export function interruptAndSteerRun(
  sessionId: string,
  text: string,
  images?: ImageInput[],
): boolean {
  const push = steerControllers.get(sessionId);
  const interrupt = interrupters.get(sessionId);
  if (!push || !interrupt) return false;
  push(text, images); // queue first so the interrupt's turn boundary releases it
  interrupt();
  return true;
}

/**
 * Money-moving Stripe tools: every call pauses for a human approve/deny in the
 * session UI (via onAskUser); unattended runs get a deny telling the agent to
 * propose the action instead. stripe_api_execute is included because it can
 * hit any endpoint the restricted key allows, including refunds and cancels.
 */
export const STRIPE_CONFIRM_TOOLS: Record<string, string> = {
  mcp__stripe__create_refund: "Create a refund",
  mcp__stripe__cancel_subscription: "Cancel a subscription",
  mcp__stripe__update_subscription: "Update a subscription",
  mcp__stripe__stripe_api_execute: "Execute a raw Stripe API call",
};

/** A pasted/dropped image, decoded to raw base64 (no `data:` prefix). */
export interface ImageInput {
  mediaType: string;
  data: string;
}

export async function* runClaude(opts: {
  prompt: string;
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  /** Images to attach to the opening message (vision). Claude only. */
  images?: ImageInput[];
  /**
   * Fork instead of continuing: when `sessionId` is set and `forkSession` is
   * true, the resumed conversation branches into a NEW engine session id rather
   * than appending to the original. Pair with `resumeSessionAt` to branch from a
   * specific past message (its UUID); omit to branch from the latest state.
   */
  forkSession?: boolean;
  resumeSessionAt?: string;
  /** Claude model id for this run; falls back to the global default (getDefaultModel). */
  model?: string;
  /**
   * MCP server allowlist for this run — only the named servers from
   * mcp-config.json are made available. Omitted = all configured servers
   * (interactive sessions). Automations should pass only what they use.
   */
  mcpServers?: string[];
  /**
   * In-process SDK MCP servers (createSdkMcpServer instances) to merge into this
   * run, keyed by name — e.g. michael-sessions / michael-admin for interactive
   * Backstage sessions. These run in the parent process, so ONLY pass them for
   * trusted interactive runs; never for automations (untrusted ticket text must
   * not get session-control / self-management tools). Not journaled — rebuilt
   * fresh from caller context on each run/resume.
   */
  inProcessMcp?: Record<string, unknown>;
  /**
   * System-prompt note listing the session's repos (primary + attached) and
   * their worktree paths for cross-repo sessions, so the agent cd's into the
   * right isolated checkout. Appended to the system prompt; trusted runs only.
   */
  reposNote?: string;
  /**
   * Tools to hard-deny at the permission layer, mapping tool name → message
   * shown to the agent. Enforced in canUseTool, so it holds even if the
   * prompt (e.g. freeform ticket text) tries to talk the agent into it.
   */
  deniedTools?: Record<string, string>;
  /**
   * Tools that need an explicit human approve/deny per call, mapping tool
   * name → short action label. With onAskUser available the run pauses on an
   * approval card showing the exact input; without it (unattended runs) the
   * call is denied with instructions to propose the action for a human.
   */
  confirmTools?: Record<string, string>;
  /**
   * Inject short-lived AWS credentials (instance-role read scope) into the
   * child env. Off by default; the run's `aws` calls otherwise have no creds
   * since IMDS is blocked. Enable for runs that legitimately need AWS.
   */
  aws?: boolean;
  /**
   * Git identity for commits this run makes, attributing them to the prompt's
   * author. Set on the child process env (not via git config) so concurrent runs
   * in separate worktrees never race. Omitted = the machine's default identity.
   */
  author?: GitIdentity | null;
  /**
   * The run's user (prompt author / UI user), used to gate per-user MCP servers
   * (mcp-config.json `allowedUsers`). Journaled so a resume keeps the same
   * visibility. Omitted = anonymous, which sees only unrestricted servers.
   */
  user?: string;
  /** Usage-limit fallback model chosen by the dispatcher; journaled for resume. */
  fallbackModel?: string;
  /**
   * Pinned subscription (claude-accounts id) for this session. Preferred when
   * it's usable; falls back to the normal pool pick otherwise, and rotates into
   * the pool on exhaustion. Journaled so a resume keeps the pin.
   */
  accountId?: string;
  journal?: { bksSessionId?: string; kind?: string };
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode, mcpServers, deniedTools, confirmTools, aws, author, user, journal, onAskUser } = opts;
  const model = opts.model || getDefaultModel();
  const isAsk = mode === "ask";

  // Test hook: pretend the whole Claude account pool is exhausted, so the
  // usage-limit fallback chain can be verified without burning real limits.
  // Set MICHAEL_FORCE_LIMIT=1 on a dev process only — never the service env.
  if (process.env.MICHAEL_FORCE_LIMIT === "1") {
    yield {
      type: "done",
      result: "Claude AI usage limit reached|forced-by-MICHAEL_FORCE_LIMIT",
      provider: "claude",
      model,
      usageLimitExhausted: true,
    };
    return;
  }

  if (sessionId && isSessionBusy(sessionId)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const awsEnv = aws ? await getAgentAwsEnv() : undefined;

  const abortController = new AbortController();
  const runKey = sessionId || crypto.randomUUID();
  // Key the run by every id a canceller might know — the run key, the engine
  // session id (added on init below), and the backstage session id. Without
  // the bks key, a fresh run (runKey is a random UUID until the first resume)
  // can't be cancelled by callers that only hold the bks id, e.g. the Slack
  // Stop button on an automation-triggered session. Mirrors codex-runner.
  const activeKeys = new Set<string>([runKey]);
  if (journal?.bksSessionId) activeKeys.add(journal.bksSessionId);
  for (const key of activeKeys) activeRuns.set(key, abortController);
  journalSet({
    runKey,
    bksSessionId: journal?.bksSessionId,
    claudeSessionId: sessionId,
    prompt,
    cwd,
    mode,
    mcpServers,
    user,
    deniedTools,
    confirmTools,
    aws,
    model: opts.model,
    fallbackModel: opts.fallbackModel,
    kind: journal?.kind,
    startedAt: new Date().toISOString(),
  });

  // Audit trail (incident-agent style): one claude_turn_event per prompt,
  // assistant block, tool call/result, and outcome. Bodies are stored as
  // sha256 + bounded snippet — the full text lives in the session jsonl.
  const turnId = crypto.randomUUID();
  let resultSessionId = sessionId || "";
  // Per-run token/cost accumulators, folded across every result message this run
  // produces (a run spans multiple turns via steer-release / bg-task holds).
  // Attached to the terminal `done`. `runContextTokens` tracks the LAST turn's
  // full prompt size (the current context-window fill), not a sum.
  const runUsage: TurnUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
  };
  // Fork happens once, on the first attempt; after the SDK hands back the new
  // forked session id (init) we just resume that id on any rotation retry.
  let forkConsumed = false;
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      turn_id: turnId,
      run_key: runKey,
      bks_session_id: journal?.bksSessionId,
      run_kind: journal?.kind,
      mode: mode || "code",
      claude_session_id: resultSessionId || undefined,
      ...fields,
    });

  turnEvent({
    direction: "in",
    kind: "user_prompt",
    cwd,
    mcp_servers: mcpServers,
    denied_tools: deniedTools ? Object.keys(deniedTools) : undefined,
    aws: aws ?? false,
    ...summarizeText(prompt),
  });

  // Steering state. Messages pushed via steerRun while this run is in flight
  // are held in steerPending and released into the query ONLY at a turn
  // boundary (when a result message lands) — the CLI ignores stream-json user
  // input delivered mid-turn (verified: the message is consumed but no new
  // turn ever starts, hanging the run). Each boundary release starts exactly
  // one more turn in the same query, so the end-of-run rule stays simple:
  // finish on a result with nothing held.
  const steerPending: Array<{ text: string; images?: ImageInput[] }> = [];
  let steerWake: (() => void) | null = null; // woken by releaseSteers/shutdown
  let steerReleases = 0; // boundary releases granted but not yet consumed
  let inputDone = false;
  const releaseSteers = () => {
    steerReleases++;
    steerWake?.();
  };
  const mkUserMsg = (content: string): SDKUserMessage =>
    ({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    }) as SDKUserMessage;
  // The opening message — and steered follow-ups — can carry pasted/dropped
  // images as content blocks.
  const mkUserMsgWithImages = (text: string, images?: ImageInput[]): SDKUserMessage => {
    if (!images || images.length === 0) return mkUserMsg(text);
    const blocks: unknown[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const im of images) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: im.mediaType, data: im.data },
      });
    }
    return {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  };
  const pushSteer = (text: string, images?: ImageInput[]) => {
    turnEvent({
      direction: "in",
      kind: "steered_prompt",
      ...summarizeText(text),
      ...(images?.length ? { images: images.length } : {}),
    });
    steerPending.push({ text, images });
    // Parked at a held turn boundary (background tasks pending, no turn
    // running): there is no upcoming result to release this, so deliver now.
    if (atBoundaryHold) {
      atBoundaryHold = false;
      releaseSteers();
    }
  };

  // Background task (Task/Agent/Bash run_in_background) tracking. The CLI
  // process OWNS its background tasks: if the run finishes at a turn boundary
  // while tasks are in flight, the process exit kills them mid-work (their
  // transcripts get "[Request interrupted]"; the next resume reports
  // "Background task stopped: no completion record…"). So a `result` with
  // pending tasks HOLDS the query open — the same machinery steering uses —
  // instead of finishing. While held, the CLI delivers each task's
  // notification and starts the follow-up turn itself (nudged by a synthetic
  // steer if it doesn't within 10s). The run finishes on the first result
  // with nothing pending and nothing steered — or once the hold deadline
  // expires: a background dev server never "completes", so without a deadline
  // the run would never end. Task events reset the deadline; expiry gives the
  // model one wrap-up turn (TaskOutput/TaskStop), then the next result
  // finishes even with tasks pending.
  const pendingBgTasks = new Map<string, string>(); // task_id → description
  let atBoundaryHold = false; // parked at a turn boundary waiting on bg tasks
  let holdExpired = false; // deadline passed → next result finishes anyway
  let holdNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let holdDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const BG_HOLD_MAX_MS = Number(process.env.BACKSTAGE_BG_HOLD_MAX_MS || 20 * 60_000);
  const clearHoldTimers = () => {
    if (holdNudgeTimer) clearTimeout(holdNudgeTimer);
    if (holdDeadlineTimer) clearTimeout(holdDeadlineTimer);
    holdNudgeTimer = holdDeadlineTimer = null;
  };
  // The CLI is expected to start the follow-up turn itself after a task
  // notification lands at a held boundary; if it hasn't within 10s, force one
  // so the run can't wedge. (pushSteer releases immediately while held.)
  const nudgeHeldBoundary = () => {
    if (holdNudgeTimer) return;
    holdNudgeTimer = setTimeout(() => {
      holdNudgeTimer = null;
      if (!atBoundaryHold || abortController.signal.aborted) return;
      pushSteer(
        "A background task finished while you were idle. Review its result " +
          "(the task notification above, or TaskOutput) and continue the work; " +
          "if everything is done, wrap up and end your turn."
      );
    }, 10_000);
  };
  const armHoldDeadline = () => {
    if (holdDeadlineTimer) clearTimeout(holdDeadlineTimer);
    holdDeadlineTimer = setTimeout(() => {
      holdDeadlineTimer = null;
      if (abortController.signal.aborted || holdExpired) return;
      holdExpired = true;
      turnEvent({ direction: "out", kind: "bg_task_hold_expired", pending: pendingBgTasks.size });
      if (atBoundaryHold) {
        pushSteer(
          `Background task(s) have reported nothing for ${Math.round(BG_HOLD_MAX_MS / 60_000)} minutes: ` +
            [...pendingBgTasks.values()].join("; ").slice(0, 300) +
            ". Stop waiting. Check them with TaskOutput, TaskStop anything that shouldn't keep running " +
            "(a long-lived dev server is fine to leave), summarize where the work stands, and end your " +
            "turn. When this session closes, still-running background tasks are killed."
        );
      }
    }, BG_HOLD_MAX_MS);
  };
  // Points at the live Query of the current rotation attempt; lets
  // interruptAndSteerRun stop the in-flight turn without killing the run.
  let currentInterrupt: (() => void) | null = null;
  const steerKeys = new Set<string>([runKey]);
  if (journal?.bksSessionId) steerKeys.add(journal.bksSessionId);
  const registerSteerKey = (key: string) => {
    steerKeys.add(key);
    steerControllers.set(key, pushSteer);
    interrupters.set(key, () => currentInterrupt?.());
    pendingSteerProbes.set(key, () => steerPending.length);
    steerDiscarders.set(key, () => steerPending.splice(0).length);
  };
  for (const k of [...steerKeys]) registerSteerKey(k);
  // Stop accepting steers (steerRun → false; callers fall back to their queue)
  const stopAcceptingSteers = () => {
    for (const k of steerKeys) {
      steerControllers.delete(k);
      interrupters.delete(k);
      pendingSteerProbes.delete(k);
      steerDiscarders.delete(k);
    }
  };
  const mkInputStream = (initial: string) =>
    (async function* (): AsyncGenerator<SDKUserMessage> {
      yield mkUserMsgWithImages(initial, opts.images);
      while (true) {
        if (inputDone) return;
        if (steerReleases > 0) {
          steerReleases--;
          const batch = steerPending.splice(0);
          if (batch.length > 0) {
            const text = batch
              .map((b) => b.text)
              .filter(Boolean)
              .join("\n\n");
            const images = batch.flatMap((b) => b.images ?? []);
            yield images.length
              ? mkUserMsgWithImages(text, images)
              : mkUserMsg(text);
          }
          continue;
        }
        await new Promise<void>((resolve) => (steerWake = resolve));
        steerWake = null;
      }
    })();

  try {
    // Account rotation: prefer the token pool (claude-accounts.ts) — the
    // run's user gets their personal sub first, the shared pool as backup
    // (automations have no user, so they only ever draw from the pool). When
    // a run exhausts an account's usage, sideline it and retry on the next
    // one until nothing eligible is left. With no pool configured, fall back
    // to the legacy one-shot credentials-file switch (~/.claude/accounts).
    const triedAccountIds = new Set<string>();
    // A session-pinned subscription wins the first pick when it's usable; the
    // normal pool pick (personal-first, shared fallback) covers the unpinned
    // case and takes over once the pin is exhausted (rotateAfterLimit below).
    let account: ClaudeAccount | undefined =
      (opts.accountId ? getUsableAccountById(opts.accountId, model) : undefined) ??
      pickAccount(triedAccountIds, user, model);
    let legacySwitched = false;

    const rotateAfterLimit = (): string | undefined => {
      if (account) {
        triedAccountIds.add(account.id);
        markExhausted(account.id, model);
        const next = pickAccount(triedAccountIds, user, model);
        if (!next) return undefined;
        account = next;
        return next.name;
      }
      if (legacySwitched) return undefined;
      const next = switchClaudeAccountAfterLimit();
      if (next) legacySwitched = true;
      return next;
    };

    if (account) {
      turnEvent({ direction: "out", kind: "account_used", account: account.name });
    }

    for (;;) {
      let shouldRetryAfterSwitch = false;
      // Background tasks belong to one CLI process — a rotation retry starts a
      // fresh process, so tracked tasks from the previous attempt are dead.
      pendingBgTasks.clear();
      atBoundaryHold = false;
      clearHoldTimers();
      const q = query({
        prompt: mkInputStream(prompt),
        options: {
        resume: resultSessionId || sessionId || undefined,
        // Fork applies only on the first attempt (before resultSessionId is the
        // new forked id); once forked, later rotations just resume the fork.
        ...(opts.forkSession && !forkConsumed
          ? { forkSession: true as const, ...(opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {}) }
          : {}),
        cwd,
        model,
        allowedTools: isAsk
          ? [
              "Bash", "Read", "Grep", "Glob",
              "Task", "TaskOutput", "Agent", "WebFetch", "WebSearch",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ]
          : [
              "Bash", "Read", "Edit", "Write", "Grep", "Glob",
              "Task", "TaskOutput", "Agent", "Workflow", "TaskStop",
              "WebFetch", "WebSearch",
              "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ],
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          if (deniedTools && toolName in deniedTools) {
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: "deny",
              reason: "denied_tool",
            });
            return { behavior: "deny" as const, message: deniedTools[toolName] };
          }
          if (confirmTools && toolName in confirmTools) {
            if (!onAskUser) {
              turnEvent({
                direction: "out",
                kind: "permission_decision",
                tool_name: toolName,
                decision: "deny",
                reason: "confirm_unattended",
              });
              return {
                behavior: "deny" as const,
                message:
                  `"${confirmTools[toolName]}" requires per-call human approval, and this run is unattended. ` +
                  "Post the exact action you want to take (tool name and full parameters, including amounts and IDs) " +
                  "in your internal note and ask a human to open this session and approve it.",
              };
            }
            let approved = false;
            try {
              const answer = await onAskUser({
                questions: [
                  {
                    question:
                      `Michael wants to: ${confirmTools[toolName]} (${toolName})\n\n` +
                      JSON.stringify(input, null, 2),
                    header: "Stripe",
                    options: [
                      { label: "Approve", description: "Execute this action against live Stripe" },
                      { label: "Deny", description: "Block it — Michael continues without executing" },
                    ],
                    multiSelect: false,
                  },
                ],
              });
              if (answer.behavior === "allow") {
                const answers = (answer.updatedInput as any)?.answers as
                  | Record<string, string>
                  | undefined;
                approved = Object.values(answers || {}).includes("Approve");
              }
            } catch {
              approved = false;
            }
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: approved ? "allow" : "deny",
              reason: "human_confirmation",
            });
            if (approved) return { behavior: "allow" as const, updatedInput: input };
            return {
              behavior: "deny" as const,
              message:
                "This action was NOT executed — no human approved it (denied or timed out). " +
                "Do not retry; record the proposed action and its status in your summary.",
            };
          }
          if (toolName === "AskUserQuestion") {
            if (onAskUser) {
              try {
                const answer = await onAskUser(input);
                turnEvent({
                  direction: "out",
                  kind: "permission_decision",
                  tool_name: toolName,
                  decision: answer.behavior,
                  reason: "ask_user",
                });
                return answer;
              } catch (e: any) {
                turnEvent({
                  direction: "out",
                  kind: "permission_decision",
                  tool_name: toolName,
                  decision: "deny",
                  reason: "ask_user_failed",
                });
                return {
                  behavior: "deny" as const,
                  message: `Question UI failed (${e?.message || e}) — decide yourself and note the assumption.`,
                };
              }
            }
            // Headless runs (automations) have nobody to answer
            turnEvent({
              direction: "out",
              kind: "permission_decision",
              tool_name: toolName,
              decision: "deny",
              reason: "headless",
            });
            return {
              behavior: "deny" as const,
              message:
                "This run is headless — nobody can answer questions. Use your best judgment, note the open question and your assumption in your final output.",
            };
          }
          return { behavior: "allow" as const, updatedInput: cleanPlainToolInput(toolName, input) };
        },
        // Read per run so MCP servers added/removed in the UI apply immediately;
        // merge any in-process SDK servers (michael-sessions/-admin) on top.
        mcpServers: { ...filterMcpServers(mcpServers, user), ...(opts.inProcessMcp || {}) } as any,
        strictMcpConfig: true,
        env: childEnv(awsEnv, account?.token, author),
        pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude",
        executable: "bun",
        abortController,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          ...(() => {
            const parts: string[] = [];
            if (isAsk) {
              parts.push(
                "You are Michael in Ask mode: answer questions about the current checkout. " +
                  "This is a READ-ONLY session on the main checkout — never modify, create, or delete " +
                  "files, never commit, never run state-changing commands. Explore with Read/Grep/Glob " +
                  "and read-only git commands, then answer clearly and concisely."
              );
            }
            if (opts.reposNote) {
              parts.push(opts.reposNote);
            }
            if (!isAsk && journal?.bksSessionId) {
              const link = `${UI_BASE}/session/${journal.bksSessionId}`;
              parts.push(
                "## Session link in PRs\nWhenever you open a pull request (any repo, via `gh pr " +
                  "create` or otherwise), always include a link back to this Michael session in the " +
                  "PR body so a human can open it to see how the change was made. Add a line like:\n\n" +
                  `🤖 Created by [this Michael session](${link})\n\n` +
                  "Put it at the end of the PR body. Use exactly this session URL."
              );
            }
            if (opts.inProcessMcp && Object.keys(opts.inProcessMcp).length) {
              parts.push(
                "## Managing Michael\nYou can see and steer your other Backstage sessions via the " +
                  "michael-sessions MCP tools (list_sessions — filter 'waiting' for sessions blocked on a " +
                  "question; get_session; send_to_session; answer_session_question; cancel_session; " +
                  "create_session) and manage your own setup via michael-admin (automations, MCP " +
                  "connections, channel memory). Use these tools when asked to inspect or steer sessions, " +
                  "or to change configuration, rather than only describing how."
              );
              parts.push(
                "## Model routing and Codex delegation\nUse Fable/Claude as the orchestrator for taste, " +
                  "planning, judgment, review, and user-facing decisions. Do not burn Fable tokens on bulk " +
                  "mechanical work when a cheaper worker can do it well. For clear-spec implementation, broad " +
                  "read-only codebase analysis, migrations, test-log analysis, data crunching, or computer-use " +
                  "style chores, use michael-sessions `create_session` to create a visible worker sub-session. " +
                  "Use a Codex/GPT model for mechanical work, or a Claude model when the worker needs stronger " +
                  "taste/review/judgment; Codex sessions can likewise create Claude workers. When called from this " +
                  "session, the worker is linked in the same Backstage workspace and instructed to report back here. " +
                  "For workers that only need filesystem/code access, keep `mcpServers: []` so " +
                  "unrelated external MCP startup does not slow or block them. Set `repo` to the " +
                  "registered repo id the worker should inspect or edit, such as `backstage` or `tella-fusion`. Use ask mode for " +
                  "read-only investigation and code mode with a branch for implementation. Give the worker a self-contained prompt with scope, repo/path, " +
                  "acceptance criteria, and what to report back. Keep the final judgment with this orchestrator: " +
                  "inspect the worker's summary/diff/results, rerun or escalate if the output is not good enough, " +
                  "and use Fable/Opus/Sonnet for reviews, UI/UX, copy, API design, and anything ambiguous or " +
                  "user-facing. Cost is only a tie-breaker; for shipped work prioritize intelligence, then taste, " +
                  "then cost."
              );
              if (!isAsk) {
                parts.push(
                  "## Deep-link the change for testing\nWhen your change is viewable at a specific route " +
                    "(a settings page, an editor screen, etc.), call michael-preview's `set_preview_path` with that " +
                    "root-relative path (e.g. `/settings/tags`). It makes the human's Preview and Staging buttons open " +
                    "directly on the feature under test instead of the app root, so they can verify in one click. Update " +
                    "it if the relevant route changes; pass an empty string to clear it."
                );
              }
            }
            return parts.length ? { append: parts.join("\n\n") } : {};
          })(),
        },
        settingSources: ["user", "project"],
      },
      });
      currentInterrupt = () => {
        q.interrupt().catch((e) =>
          console.warn(`[runner] interrupt() failed (turn may have already ended):`, e?.message || e)
        );
      };

      try {
      for await (const msg of q) {
        if (abortController.signal.aborted) break;

      // A held boundary ends the moment a new turn actually starts (the CLI
      // delivering a task notification as a user turn, or our nudge steer).
      if (atBoundaryHold && (msg.type === "assistant" || msg.type === "user")) {
        atBoundaryHold = false;
        if (holdNudgeTimer) {
          clearTimeout(holdNudgeTimer);
          holdNudgeTimer = null;
        }
      }

      // Background task lifecycle — feeds the boundary-hold machinery above.
      if (msg.type === "system") {
        const sm = msg as any;
        if (sm.subtype === "task_started" && sm.task_id) {
          pendingBgTasks.set(sm.task_id, sm.description || sm.task_type || "background task");
          turnEvent({
            direction: "in",
            kind: "bg_task_started",
            task_id: sm.task_id,
            ...summarizeText(sm.description || ""),
          });
        } else if (sm.subtype === "task_notification" && sm.task_id) {
          pendingBgTasks.delete(sm.task_id);
          turnEvent({
            direction: "in",
            kind: "bg_task_done",
            task_id: sm.task_id,
            task_status: sm.status,
          });
          if (atBoundaryHold) {
            armHoldDeadline(); // activity — push the deadline out
            nudgeHeldBoundary();
          }
        } else if (sm.subtype === "task_updated" && sm.task_id) {
          const st = sm.patch?.status;
          if (st === "completed" || st === "failed" || st === "killed") {
            pendingBgTasks.delete(sm.task_id);
          }
        } else if (sm.subtype === "task_progress" && sm.task_id) {
          if (atBoundaryHold) armHoldDeadline(); // still alive — keep holding
        }
      }

      if (msg.type === "system" && (msg as any).subtype === "init") {
        resultSessionId = (msg as any).session_id;
        forkConsumed = true; // we now have the forked id; don't re-fork on retry
        if (resultSessionId && !steerKeys.has(resultSessionId)) {
          registerSteerKey(resultSessionId);
        }
        if (resultSessionId && !activeKeys.has(resultSessionId)) {
          activeKeys.add(resultSessionId);
          activeRuns.set(resultSessionId, abortController);
        }
        journalSet({
          runKey,
          bksSessionId: journal?.bksSessionId,
          claudeSessionId: resultSessionId,
          prompt,
          cwd,
          mode,
          mcpServers,
          user,
          deniedTools,
          confirmTools,
          aws,
          model: opts.model,
          accountId: opts.accountId,
          kind: journal?.kind,
          startedAt: new Date().toISOString(),
        });
        yield { type: "init", sessionId: resultSessionId, provider: "claude", model };
      }

      if (msg.type === "assistant" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(block.text) });
              yield { type: "text_chunk", text: block.text };
            }
            if (block.type === "thinking" && block.thinking) {
              turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(block.thinking) });
            }
            if (block.type === "tool_use") {
              turnEvent({
                direction: "out",
                kind: "tool_use",
                tool_name: block.name,
                tool_use_id: block.id,
                ...summarizeText(JSON.stringify(block.input ?? {}), 500),
              });
              yield {
                type: "tool_use",
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
              };
            }
          }
        }
      }

      if (msg.type === "user" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const text = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : "";
              // Pull image blocks out so the live stream carries them too
              // (mirrors jsonl-parser.extractImages so a streamed result and
              // the persisted one render identically).
              const images: string[] = [];
              if (Array.isArray(block.content)) {
                for (const c of block.content) {
                  if (c?.type !== "image" || !c.source) continue;
                  const s = c.source;
                  if (s.type === "base64" && s.media_type && s.data) {
                    images.push(`data:${s.media_type};base64,${s.data}`);
                  } else if (s.type === "url" && s.url) {
                    images.push(s.url);
                  }
                }
              }
              // Parse BACKSTAGE_VIDEO markers out of the FULL text (before the
              // 500-char truncation below, since the marker is usually printed
              // last) so recordings stream in without a reload. Mirrors
              // jsonl-parser.extractVideos so streamed and persisted match.
              const videos: string[] = [];
              for (const m of text.matchAll(/^\s*BACKSTAGE_VIDEO:\s*(\/\S+)\s*$/gm)) {
                videos.push(`/backstage/media?path=${encodeURIComponent(m[1])}`);
              }
              turnEvent({
                direction: "in",
                kind: "tool_result",
                tool_use_id: block.tool_use_id,
                is_error: block.is_error ?? false,
                ...summarizeText(text),
              });
              yield {
                type: "tool_result",
                toolUseId: block.tool_use_id,
                content: text.length > 500 ? text.slice(0, 500) + "..." : text,
                ...(images.length > 0 ? { images } : {}),
                ...(videos.length > 0 ? { videos } : {}),
              };
            }
          }
        }
      }

      if (msg.type === "result") {
        const rm = msg as any;
        resultSessionId = rm.session_id || resultSessionId;
        const resultText = rm.subtype === "success" ? rm.result : `Error: ${rm.errors?.join(", ") || "Unknown"}`;

        turnEvent({
          direction: "out",
          kind: "result",
          result_subtype: rm.subtype,
          is_error: rm.is_error ?? rm.subtype !== "success",
          duration_ms: rm.duration_ms,
          num_turns: rm.num_turns,
          total_cost_usd: rm.total_cost_usd,
          input_tokens: rm.usage?.input_tokens,
          output_tokens: rm.usage?.output_tokens,
          cache_read_input_tokens: rm.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: rm.usage?.cache_creation_input_tokens,
          ...summarizeText(resultText),
        });

        // Fold this turn into the run's cumulative usage. We price from the
        // published API rate table (input/output/cache split — matching the
        // billing model), NOT the SDK's total_cost_usd: subscription (OAuth)
        // runs report total_cost_usd = 0, but the whole point here is the
        // API-equivalent cost that usage-credits will charge. Fall back to the
        // SDK figure only for unpriced (passthrough) models. Context size = this
        // turn's full prompt (input + both cache buckets), overwritten each turn
        // so it reflects the current window fill, not a running sum.
        const inTok = rm.usage?.input_tokens || 0;
        const outTok = rm.usage?.output_tokens || 0;
        const cacheReadTok = rm.usage?.cache_read_input_tokens || 0;
        const cacheCreateTok = rm.usage?.cache_creation_input_tokens || 0;
        runUsage.inputTokens += inTok;
        runUsage.outputTokens += outTok;
        runUsage.cacheReadTokens += cacheReadTok;
        runUsage.cacheCreationTokens += cacheCreateTok;
        const turnCost = hasPricing(model)
          ? priceUsageUsd(model, {
              input: inTok,
              output: outTok,
              cacheRead: cacheReadTok,
              cacheWrite: cacheCreateTok,
            })
          : typeof rm.total_cost_usd === "number"
            ? rm.total_cost_usd
            : undefined;
        if (typeof turnCost === "number")
          runUsage.costUsd = (runUsage.costUsd || 0) + turnCost;
        runUsage.contextTokens = inTok + cacheReadTok + cacheCreateTok;

        let limitExhausted = false;
        if (isClaudeUsageLimitError(resultText, rm.subtype !== "success")) {
          const nextAccount = rotateAfterLimit();
          if (nextAccount) {
            turnEvent({ direction: "out", kind: "account_switch", account: nextAccount });
            shouldRetryAfterSwitch = true;
            yield {
              type: "text_chunk",
              text: `\n\n[runner] Claude usage limit hit; switched to ${nextAccount} and retrying.\n\n`,
            };
            break;
          }
          // No account left to rotate to — surface that so a dispatcher with a
          // fallback model can take over.
          limitExhausted = true;
        }

        // Turn boundary: release steered messages into the same query as a
        // fresh turn instead of finishing. (Skipped when the run is dying on
        // usage limits — the queued text stays in steerPending and callers'
        // queue fallback picks it up once steering deregisters.)
        if (!limitExhausted && steerPending.length > 0) {
          turnEvent({ direction: "out", kind: "steer_release", count: steerPending.length });
          releaseSteers();
          continue;
        }

        // Background tasks still in flight? Hold the boundary open instead of
        // finishing — the process exit would kill them. The CLI (or our nudge)
        // starts the follow-up turn when a task reports back. Skipped once the
        // hold deadline has expired, and when dying on usage limits.
        if (!limitExhausted && !holdExpired && pendingBgTasks.size > 0) {
          atBoundaryHold = true;
          turnEvent({ direction: "out", kind: "bg_task_hold", pending: pendingBgTasks.size });
          yield {
            type: "text_chunk",
            text:
              `\n\n[runner] Holding the session open — ${pendingBgTasks.size} background task(s) ` +
              `still running (${[...pendingBgTasks.values()].join("; ").slice(0, 200)}). ` +
              `Their results land back in this session.\n\n`,
          };
          armHoldDeadline();
          continue;
        }

        // Finishing: stop accepting steers first, then re-check — a message
        // that raced in between gets one more turn rather than being dropped.
        stopAcceptingSteers();
        if (!limitExhausted && steerPending.length > 0) {
          releaseSteers();
          continue;
        }

        yield {
          type: "done",
          sessionId: resultSessionId,
          result: resultText,
          provider: "claude",
          model,
          usageLimitExhausted: limitExhausted || undefined,
          usage: runUsage,
        };
        return;
      }
    }
      } catch (e: any) {
        // Usage limits can also surface as a thrown stream error (CLI process
        // exit), not just a result message — rotate and resume the session.
        if (
          !abortController.signal.aborted &&
          isClaudeUsageLimitError(e?.message || String(e), true)
        ) {
          const nextAccount = rotateAfterLimit();
          if (nextAccount) {
            turnEvent({ direction: "out", kind: "account_switch", account: nextAccount });
            yield {
              type: "text_chunk",
              text: `\n\n[runner] Claude usage limit hit; switched to ${nextAccount} and retrying.\n\n`,
            };
            continue;
          }
        }
        throw e;
      }

      if (!shouldRetryAfterSwitch) break;
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      const message = e.message || String(e);
      turnEvent({ direction: "out", kind: "error", error: message });
      yield {
        type: "error",
        content: message,
        provider: "claude",
        model,
        usageLimitExhausted: isClaudeUsageLimitError(message, true) || undefined,
      };
    }
  } finally {
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    stopAcceptingSteers();
    clearHoldTimers();
    inputDone = true;
    // Wake the input stream so it sees inputDone and closes. (A direct
    // `steerWake?.()` here trips TS narrowing: it's only ever assigned inside
    // the generator closure, so CFA still thinks it's null at this point.)
    releaseSteers();
    for (const key of activeKeys) activeRuns.delete(key);
    journalClear(runKey);
  }
}

// resumeInterruptedRuns lives in agent-runner.ts — it routes each interrupted
// run to the right backend (Claude or Codex) based on the journaled model.
