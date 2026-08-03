/**
 * Claude-direct engine adapter — EXPERIMENTAL (transcript-v2 design §7).
 *
 * Runs a turn through the in-process @anthropic-ai/claude-agent-sdk `query()`
 * (the same SDK surface anthropic-bridge.ts already drives in production —
 * this file inherits its audit-event discipline) instead of going
 * opencode → Meridian bridge → SDK. Unlike the bridge, tools are NOT blocked
 * passthroughs: the SDK executes its own tools in `opts.cwd`, and the message
 * stream is normalized into the shared StreamEvent shapes.
 *
 * Containment / scope (all enforced here):
 *  - Hard flag gate: every turn refuses unless
 *    `OPENSESSION_ENGINE_CLAUDE_DIRECT=1` (envAlias — old BACKSTAGE_ name
 *    honored). NEVER wired into model pickers or defaults; callers are
 *    scripted throwaway test sessions (`bks-test-claude-direct-*`) only.
 *  - Auth: a subscription account from claude-accounts (pickAccount /
 *    getUsableAccountById; markExhausted on usage-limit death) via
 *    CLAUDE_CODE_OAUTH_TOKEN, plus an ISOLATED per-account CLAUDE_CONFIG_DIR
 *    under ~/.opensession-claude-direct — the SDK subprocess must never see
 *    host ~/.claude credentials (the silent host-credential fallback the
 *    bridge's env block leaves open is closed here on purpose).
 *  - Minimal subprocess env: PATH/HOME/LANG + the two vars above. No
 *    OpenSession tokens, ever.
 *  - Transcript: store-only since the 2026-07-23 mirror retirement (§11) —
 *    normalized entries go through appendOpencodeTranscript(sdkSessionId, …)
 *    as claude-shape jsonl lines, which storeAppendLines (opencode-transcript
 *    .ts) parses into the transcript store WITH the W1
 *    import-first gate (§3): the SDK→unified session mapping is registered
 *    up front via recordBksSessionFor, so a session with legacy history gets
 *    that history imported before its first live seq (never marked
 *    'live-only' with orphaned history), and store uuids are the
 *    parser-derived ids imports/re-imports produce (no duplicate rows from a
 *    parallel hand-built id scheme). /entry, FTS and every legacy read path
 *    keep working.
 *
 * Known v0 gaps (documented, acceptable for experimental):
 *  - steer(): unsupported (single-shot prompt; no streaming-input session) —
 *    always false, callers queue.
 *  - reattach(): unsupported (SDK runs are direct children, nothing survives
 *    a restart) — always null; activeDetachedRunCount() is 0.
 *  - Image attachments on the prompt are not delivered yet (a runner_notice
 *    says so in-stream).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "fs";
import { envAlias, stateDir } from "../rename-compat";
import { audit, summarizeText } from "../audit";
import {
  pickAccount,
  getUsableAccountById,
  getAccountById,
  markExhausted,
  type ClaudeAccount,
} from "../claude-accounts";
import {
  CLAUDE_CODE_BIN,
  isClaudeUsageLimitError,
} from "../runner-shared";
import {
  appendOpencodeTranscript,
  recordBksSessionFor,
  transcriptLineForEntry,
  transcriptLineRunnerNotice,
} from "../opencode-transcript";
import { transcriptStore } from "../transcript-store";
import type { TranscriptEntry } from "../types";
import type {
  EngineAdapter,
  RunAgentOpts,
  StreamEvent,
  TurnUsage,
} from "./adapter-types";

const g = globalThis as any;

/** State root for the experimental engine: per-account CLAUDE_CONFIG_DIRs and
 *  the smoke-turn scratch cwd live under here, never under host ~/.claude. */
export const CLAUDE_DIRECT_STATE_DIR = stateDir("claude-direct");

/** The experiment flag. Read at call time (envAlias semantics), so flipping
 *  the env var needs no code change — but the adapter itself is inert until
 *  something imports it anyway. */
export function claudeDirectEnabled(): boolean {
  return (
    envAlias("OPENSESSION_ENGINE_CLAUDE_DIRECT", "BACKSTAGE_ENGINE_CLAUDE_DIRECT") === "1"
  );
}

// Live-run registry (alias keys: unified session id + SDK session id), parked
// on globalThis so a hot reload keeps cancel/isBusy working for in-flight
// experimental turns — same pattern as the opencode runner's activeRuns.
const activeRuns: Map<string, AbortController> = (g.__claudeDirectActiveRuns ??= new Map());

export function isClaudeDirectBusy(id: string): boolean {
  return activeRuns.has(id);
}

export function cancelClaudeDirectRun(id: string): boolean {
  const ac = activeRuns.get(id);
  if (!ac) return false;
  ac.abort();
  return true;
}

// ── Transcript integration ───────────────────────────────────────────────────

/** Store one batch of normalized entries, keyed by the engine/SDK session
 *  id: appendOpencodeTranscript (store-only since mirror retirement) parses
 *  the claude-shape lines into the transcript store through the W1
 *  import-first gate — provided recordBksSessionFor mapped this SDK session
 *  to its unified session id first (see mapEngineSession in runClaudeDirect;
 *  unmapped batches are skipped with a once-per-session warn + degraded
 *  mark). System entries ride a <runner-notice> user line, which the shared
 *  parser maps back to a system chip — transcriptLineForEntry has no system
 *  shape, and dropping them here would lose them entirely. Best-effort — a
 *  transcript write must never take the run down. */
function persistEntries(
  engineSessionId: string | undefined,
  entries: TranscriptEntry[]
): void {
  if (!entries.length || !engineSessionId) return;
  try {
    const lines = entries
      .map((e) =>
        e.type === "system"
          ? transcriptLineRunnerNotice(e.content, e.id, e.timestamp)
          : transcriptLineForEntry(e)
      )
      .filter((l): l is Record<string, unknown> => !!l);
    appendOpencodeTranscript(engineSessionId, lines);
  } catch (e) {
    console.warn("[claude-direct] transcript persist failed:", e);
  }
}

// ── SDK message normalization helpers ────────────────────────────────────────

function nativeClaudeModel(model: string): string {
  return model.replace(/^opencode\/anthropic\//, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Flatten a tool_result block's content to plain text (string or text-block
 *  array — same subset anthropic-bridge reads). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function turnUsageFrom(rm: {
  usage?: Record<string, number | undefined> | null;
  total_cost_usd?: number;
}): TurnUsage {
  const u = rm.usage || {};
  const input = u.input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  return {
    costUsd: typeof rm.total_cost_usd === "number" ? rm.total_cost_usd : undefined,
    inputTokens: input,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    contextTokens: input + cacheRead + cacheCreate,
  };
}

/** Account for this run: honor a pinned accountId first (strict pins never
 *  widen to the pool — automation cost-cap semantics), else the normal
 *  personal-first pool pick. */
function pickDirectAccount(opts: RunAgentOpts, model: string):
  | { account: ClaudeAccount }
  | { error: string } {
  if (opts.accountId) {
    const pinned = getUsableAccountById(opts.accountId, model, opts.usageCredits);
    if (pinned) return { account: pinned };
    if (opts.accountStrict) {
      const name = getAccountById(opts.accountId)?.name || opts.accountId;
      return { error: `pinned account "${name}" is not usable right now (strict pin — not widening to the pool)` };
    }
  }
  const picked = pickAccount(undefined, opts.user, model, opts.usageCredits);
  if (picked) return { account: picked };
  return { error: "no usable Claude account in the pool" };
}

/** Tools ask mode must never run (the SDK executes tools itself here — unlike
 *  the bridge — so mutation tools are denied at the permission layer). Bash is
 *  denied wholesale in v0: the opencode ask-mode read-only bash allowlist
 *  (ASK_BASH_PERMISSIONS) is not ported yet, and an unfiltered Bash would make
 *  "read-only session" a fiction — revisit when the allowlist is shared. */
const ASK_MODE_DENIED_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

// ── The turn ─────────────────────────────────────────────────────────────────

export async function* runClaudeDirect(
  opts: RunAgentOpts,
  model: string
): AsyncGenerator<StreamEvent> {
  const nativeModel = nativeClaudeModel(model);
  if (!claudeDirectEnabled()) {
    yield {
      type: "error",
      content:
        "claude-direct engine is disabled (experimental). Set OPENSESSION_ENGINE_CLAUDE_DIRECT=1 to enable — " +
        "it is never part of the normal model pickers.",
      provider: "claude",
      model: nativeModel,
    };
    return;
  }
  if (!/^claude-/.test(nativeModel)) {
    yield {
      type: "error",
      content: `claude-direct only runs Anthropic models (got "${model}")`,
      provider: "claude",
      model: nativeModel,
    };
    return;
  }

  const picked = pickDirectAccount(opts, nativeModel);
  if ("error" in picked) {
    // Pool dry at pick time: same contract as the opencode runner — a
    // pre-init terminal error flagged usageLimitExhausted drives the
    // fallback walk in agent-runner.
    yield {
      type: "error",
      content: `claude-direct: ${picked.error}`,
      provider: "claude",
      model: nativeModel,
      usageLimitExhausted: true,
    };
    return;
  }
  const account = picked.account;

  // Isolated per-account SDK config dir — the whole point vs. the bridge's
  // env block: the subprocess can never fall back to host ~/.claude creds.
  const configDir = `${CLAUDE_DIRECT_STATE_DIR}/cfg/${account.id}`;
  try {
    mkdirSync(configDir, { recursive: true });
  } catch {}

  const unifiedSessionId = opts.journal?.bksSessionId;
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const auditBase = {
    msg: "claude_direct_turn",
    request_id: requestId,
    session: unifiedSessionId,
    resume: opts.sessionId,
    model: nativeModel,
    mode: opts.mode,
    account: account.name,
  };
  audit({ ...auditBase, direction: "in", ...summarizeText(opts.prompt) });

  const abort = new AbortController();
  let engineSessionId: string | undefined = opts.sessionId;
  const registered = new Set<string>();
  const register = (id: string | undefined) => {
    if (!id || registered.has(id)) return;
    registered.add(id);
    activeRuns.set(id, abort);
  };
  register(unifiedSessionId);
  register(engineSessionId);

  // Register the SDK→unified session mapping BEFORE any append: the
  // store write inside appendOpencodeTranscript resolves the unified
  // session (and runs the import-first gate, §3) through this map — without
  // it the store never sees the run, or worse, a first live append would
  // mark the session 'live-only' and orphan its legacy history. Idempotent
  // and rotation-safe (many engine ids → one unified id); recordBksSessionFor
  // never throws.
  const mapEngineSession = (id: string | undefined) => {
    if (id && unifiedSessionId) recordBksSessionFor(id, unifiedSessionId);
  };
  mapEngineSession(engineSessionId);

  // Pre-init entry buffer: the mirror file is keyed by the SDK session id,
  // unknown for fresh sessions until the init message — buffer until then.
  let pending: TranscriptEntry[] = [];
  const persist = (entries: TranscriptEntry[]) => {
    if (!engineSessionId) {
      pending.push(...entries);
      return;
    }
    if (pending.length) {
      const flush = pending;
      pending = [];
      persistEntries(engineSessionId, flush);
    }
    persistEntries(engineSessionId, entries);
  };

  persist([
    {
      id: `cd-${requestId}-user`,
      type: "user",
      content: opts.prompt,
      timestamp: nowIso(),
    },
  ]);

  const onAskUser = opts.onAskUser;
  const mode = opts.mode;

  try {
    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        model: nativeModel,
        resume: opts.sessionId,
        forkSession: opts.forkSession,
        abortController: abort,
        settingSources: [],
        systemPrompt: opts.reposNote
          ? { type: "preset", preset: "claude_code", append: opts.reposNote }
          : undefined,
        pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
        executable: "bun" as const,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          CLAUDE_CODE_OAUTH_TOKEN: account.token,
          CLAUDE_CONFIG_DIR: configDir,
        },
        canUseTool: async (toolName, input) => {
          if (toolName === "AskUserQuestion") {
            // The blocking permission-ask contract: park the turn on the
            // caller's handler (web UI card + Slack escalation). Without a
            // handler (scripted/smoke runs) deny instead of allowing the SDK
            // to execute an interactive tool nobody can answer.
            if (onAskUser) return onAskUser(input);
            return {
              behavior: "deny",
              message:
                "No interactive ask handler on this run — decide with your best judgment and continue.",
            };
          }
          if (mode !== "code" && ASK_MODE_DENIED_TOOLS.has(toolName)) {
            return {
              behavior: "deny",
              message: `${toolName} is not available in ask mode (read-only session).`,
            };
          }
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    if (opts.images?.length) {
      const note =
        `claude-direct (experimental) did not deliver ${opts.images.length} attached image(s) — ` +
        "image input is not wired in v0.";
      persist([
        { id: `cd-${requestId}-imgnote`, type: "system", content: note, timestamp: nowIso() },
      ]);
      yield { type: "runner_notice", text: note };
    }

    let sawInit = false;
    let terminal: StreamEvent | null = null;

    for await (const msg of q) {
      const m = msg as Record<string, any>;
      if (m.type === "system" && m.subtype === "init") {
        engineSessionId = String(m.session_id || engineSessionId || "");
        register(engineSessionId);
        mapEngineSession(engineSessionId);
        sawInit = true;
        yield {
          type: "init",
          sessionId: engineSessionId,
          provider: "claude",
          model: nativeModel,
        };
        // Flush the buffered user entry now that the mirror key exists.
        persist([]);
        continue;
      }
      if (m.type === "assistant") {
        const blocks = m.message?.content;
        const msgTs = nowIso();
        const msgUuid: string = String(m.uuid || crypto.randomUUID());
        if (Array.isArray(blocks)) {
          let textIdx = 0;
          for (const b of blocks) {
            if (!b || typeof b !== "object") continue;
            if (b.type === "text" && b.text) {
              yield { type: "text_chunk", text: b.text };
              persist([
                {
                  id: textIdx === 0 ? msgUuid : `${msgUuid}-b${textIdx}`,
                  type: "assistant",
                  content: b.text,
                  timestamp: msgTs,
                  model: nativeModel,
                },
              ]);
              textIdx++;
            } else if (b.type === "tool_use" && b.id) {
              yield {
                type: "tool_use",
                toolName: String(b.name || "Tool"),
                toolInput: b.input ?? {},
                toolUseId: String(b.id),
              };
              persist([
                {
                  id: String(b.id),
                  type: "tool_use",
                  content: "",
                  timestamp: msgTs,
                  toolName: String(b.name || "Tool"),
                  toolInput: b.input ?? {},
                  toolUseId: String(b.id),
                },
              ]);
            }
          }
        }
        continue;
      }
      if (m.type === "user") {
        // SDK-executed tool results ride user messages.
        const blocks = m.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (!b || typeof b !== "object" || b.type !== "tool_result" || !b.tool_use_id)
              continue;
            const text = toolResultText(b.content);
            const isError = b.is_error === true;
            yield {
              type: "tool_result",
              toolUseId: String(b.tool_use_id),
              result: text,
            };
            persist([
              {
                id: `${b.tool_use_id}-result`,
                type: "tool_result",
                content: text,
                timestamp: nowIso(),
                toolUseId: String(b.tool_use_id),
                ...(isError ? { isError: true } : {}),
              },
            ]);
          }
        }
        continue;
      }
      if (m.type === "result") {
        engineSessionId = String(m.session_id || engineSessionId || "");
        register(engineSessionId);
        mapEngineSession(engineSessionId);
        if (m.is_error || m.subtype !== "success") {
          const detail: string =
            (typeof m.result === "string" && m.result) ||
            (Array.isArray(m.errors) && m.errors.join(", ")) ||
            String(m.subtype || "SDK run failed");
          const usageLimit = isClaudeUsageLimitError(detail, true);
          if (usageLimit) markExhausted(account.id, nativeModel);
          terminal = {
            type: "error",
            content: `claude-direct: ${detail}`,
            provider: "claude",
            model: nativeModel,
            ...(usageLimit ? { usageLimitExhausted: true } : {}),
          };
        } else {
          terminal = {
            type: "done",
            sessionId: engineSessionId,
            provider: "claude",
            model: nativeModel,
            usage: turnUsageFrom(m as { usage?: Record<string, number>; total_cost_usd?: number }),
          };
        }
        break;
      }
      // Every other SDK message kind (status, hooks, task notifications,
      // partials) is engine-internal — ignored in v0.
    }

    if (!terminal) {
      terminal = abort.signal.aborted
        ? {
            type: "error",
            content: "claude-direct: run cancelled",
            provider: "claude",
            model: nativeModel,
          }
        : {
            type: "error",
            content: "claude-direct: SDK stream ended without a result message",
            provider: "claude",
            model: nativeModel,
          };
    }
    audit({
      ...auditBase,
      direction: "out",
      ok: terminal.type === "done",
      duration_ms: Date.now() - started,
      sdk_session_id: engineSessionId,
      saw_init: sawInit,
      ...(terminal.type === "done"
        ? {
            input_tokens: terminal.usage?.inputTokens,
            output_tokens: terminal.usage?.outputTokens,
            cache_read_input_tokens: terminal.usage?.cacheReadTokens,
          }
        : { error: terminal.content }),
    });
    yield terminal;
  } catch (e: any) {
    const message: string = e?.message || String(e);
    const usageLimit = isClaudeUsageLimitError(message, true);
    if (usageLimit) markExhausted(account.id, nativeModel);
    audit({
      ...auditBase,
      direction: "out",
      ok: false,
      duration_ms: Date.now() - started,
      sdk_session_id: engineSessionId,
      error: message,
    });
    yield {
      type: "error",
      content: `claude-direct: ${message}`,
      provider: "claude",
      model: nativeModel,
      ...(usageLimit ? { usageLimitExhausted: true } : {}),
    };
  } finally {
    for (const id of registered) {
      if (activeRuns.get(id) === abort) activeRuns.delete(id);
    }
  }
}

// ── Adapter surface ──────────────────────────────────────────────────────────

export const claudeDirectAdapter: EngineAdapter = {
  name: "claude-direct",
  startTurn: (opts, model) => runClaudeDirect(opts, model),
  // v0 gaps, documented in the module doc: no mid-turn steer (single-shot
  // prompt), no detached processes to reattach.
  steer: () => false,
  cancel: (id) => cancelClaudeDirectRun(id),
  isBusy: (id) => isClaudeDirectBusy(id),
  reattach: async () => null,
  activeDetachedRunCount: () => 0,
};

// ── Scripted smoke harness ───────────────────────────────────────────────────

/** The model the smoke turn runs on — cheap, and pool coverage is widest. */
const SMOKE_MODEL = "claude-sonnet-5";

export interface ClaudeDirectSmokeOptions {
  /** Prompt for the scripted turn (default: a one-word reply probe). */
  prompt?: string;
  /** Wiring probe: never execute a turn even when the flag is on — no
   *  account pick, no SDK spawn. (With the flag OFF every call is already a
   *  dry run: runClaudeDirect stops at its gate error.) */
  dryRun?: boolean;
  /** Wall-time cap for the turn (default 120s, clamped 5s–10min). On expiry
   *  the run is cancelled via the normal abort path — an abort message is
   *  not a usage-limit shape, so the account is never markExhausted'd. */
  timeoutMs?: number;
}

export interface ClaudeDirectSmokeResult {
  /** True only for a real turn that reached its terminal `done` in time —
   *  or for an explicit dryRun probe with the flag on. */
  ok: boolean;
  enabled: boolean;
  /** True when no real turn was executed (flag off, or dryRun requested). */
  dryRun: boolean;
  /** Human-readable explanation whenever ok is false or no turn ran. */
  reason?: string;
  /** Throwaway unified session id (`bks-test-claude-direct-*`) — its prefix
   *  is the "this is a test session" marker; it never gets a session file,
   *  so it can't appear in the UI session list. Store rows are purgeable
   *  later via deleteSessionTranscript(sessionId). */
  sessionId: string;
  engineSessionId?: string;
  model: string;
  eventTypes: string[];
  text: string;
  error?: string;
  usage?: TurnUsage;
  timedOut: boolean;
  durationMs: number;
  /** transcript_events rows the v2 store holds for the throwaway session
   *  after the turn (getLastSeq — seq is dense, so last seq = row count).
   *  Proves the W1 store-write path end to end; 0 on dry runs. */
  storeRows: number;
}

/**
 * One tiny scripted turn against a throwaway session id
 * (`bks-test-claude-direct-*`), for post-restart verification (design §7
 * acceptance: SDK turn → rows in transcripts.db → bus → v2 WS viewer). With
 * the flag OFF this is a pure dry-run: runClaudeDirect yields its gate error
 * before touching accounts or the SDK, so no quota is ever consumed. Safe to
 * call in-process from the admin route — it never throws, and a real turn is
 * hard-capped at `timeoutMs` wall time.
 */
export async function runClaudeDirectSmokeTurn(
  opts: ClaudeDirectSmokeOptions = {}
): Promise<ClaudeDirectSmokeResult> {
  const prompt = opts.prompt || "Reply with exactly the single word: ok";
  const timeoutMs = Math.max(5_000, Math.min(opts.timeoutMs ?? 120_000, 600_000));
  const enabled = claudeDirectEnabled();
  const sessionId = `bks-test-claude-direct-${Date.now().toString(36)}`;
  const started = Date.now();
  const storeRowsFor = (id: string): number => {
    try {
      return transcriptStore().getLastSeq(id);
    } catch {
      return 0;
    }
  };

  if (enabled && opts.dryRun) {
    return {
      ok: true,
      enabled,
      dryRun: true,
      reason:
        "dry run requested — flag is ON but no turn was executed (no account pick, no SDK spawn)",
      sessionId,
      model: SMOKE_MODEL,
      eventTypes: [],
      text: "",
      timedOut: false,
      durationMs: Date.now() - started,
      storeRows: 0,
    };
  }

  const cwd = `${CLAUDE_DIRECT_STATE_DIR}/smoke`;
  if (enabled) {
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {}
  }
  const eventTypes: string[] = [];
  let text = "";
  let error: string | undefined;
  let usage: TurnUsage | undefined;
  let engineSessionId: string | undefined;
  let done = false;
  let timedOut = false;
  // Wall clamp: runClaudeDirect registers the run under the unified session
  // id before the SDK spawns, so cancelClaudeDirectRun reaches it; the abort
  // surfaces as a terminal error event and the stream ends.
  const timer = setTimeout(() => {
    timedOut = true;
    cancelClaudeDirectRun(sessionId);
  }, timeoutMs);
  try {
    for await (const ev of runClaudeDirect(
      {
        prompt,
        cwd,
        mode: "ask",
        // Smoke probe: no connectors needed to prove the engine answers.
        mcpServers: [],
        journal: { bksSessionId: sessionId, kind: "claude-direct-smoke" },
      },
      SMOKE_MODEL
    )) {
      eventTypes.push(ev.type);
      if (ev.type === "init") engineSessionId = ev.sessionId;
      if (ev.type === "text_chunk") text += ev.text || "";
      if (ev.type === "error") error = ev.content;
      if (ev.type === "done") {
        usage = ev.usage;
        done = true;
      }
    }
  } catch (e) {
    // runClaudeDirect yields errors rather than throwing; belt-and-braces so
    // the in-process caller (admin route) can never blow up off this path.
    error = String((e as Error)?.message || e);
  } finally {
    clearTimeout(timer);
  }
  return {
    ok: done && !timedOut && !error,
    enabled,
    dryRun: !enabled,
    reason: !enabled
      ? "claude-direct engine is disabled (OPENSESSION_ENGINE_CLAUDE_DIRECT is not 1) — the gate error below is the expected dry-run result; no account or SDK use happened"
      : timedOut
        ? `smoke turn exceeded the ${timeoutMs}ms wall cap and was cancelled`
        : undefined,
    sessionId,
    engineSessionId,
    model: SMOKE_MODEL,
    eventTypes,
    text,
    error,
    usage,
    timedOut,
    durationMs: Date.now() - started,
    storeRows: storeRowsFor(sessionId),
  };
}
