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
 * through), except `opencode/anthropic/*`, which routes through the local
 * Max-subscription bridge (anthropic-bridge.ts) and fails with a clear error
 * when that bridge isn't enabled in ~/.backstage-opencode.json.
 *
 * Server lifecycle: one `opencode serve` process per backstage session (keyed
 * by bks session id, falling back to cwd), bound to 127.0.0.1 on an ephemeral
 * port with a per-server Basic-auth password, cwd = the session worktree, and
 * a minimal env (PATH/HOME/LANG + git identity — mirrors codexEnv; no
 * backstage tokens). Parked on globalThis so `bun --hot` reloads keep servers
 * alive; killed after 30 minutes idle. Config (permissions, MCP servers,
 * bridge provider override) is injected via OPENCODE_CONFIG_CONTENT at spawn;
 * a config change respawns the server (sessions persist in OpenCode's own
 * storage, so this is safe between runs).
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
 *    GATED off this engine: a run with a non-interactive journal kind or any
 *    `deniedTools` gets an immediate error event and nothing is started.
 *    Automation least-privilege therefore never depends on OpenCode config.
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

import { existsSync, mkdirSync, writeFileSync } from "fs";
import type { Subprocess } from "bun";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { RunAgentOpts } from "./agent-runner";
import {
  journalSet,
  journalClear,
  filterMcpServers,
  type StreamEvent,
  type ImageInput,
} from "./claude-runner";
import { audit, summarizeText } from "./audit";
import { gitIdentityEnv, type GitIdentity } from "./shared/user-mappings";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { BUN_BIN, MCP_PROXY_ENTRY, rpcSocketPath } from "./run-rpc-protocol";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import { isCodexUsageLimitError } from "./codex-runner";
import { ensureAnthropicBridge } from "./anthropic-bridge";

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

/** Journal kinds minted by trusted interactive paths (backstage.ts). Everything
 *  else — automation, action, github-…, security-scan, and their -resume/
 *  -rerun/-fallback derivatives — is fail-closed off this engine. */
const INTERACTIVE_KINDS = new Set(["", "prompt", "goal", "create"]);

/** Non-null = the reason this run may not use the opencode engine. */
export function opencodeGateReason(opts: {
  deniedTools?: Record<string, string>;
  journal?: { kind?: string };
}): string | null {
  if (Object.keys(opts.deniedTools || {}).length > 0) {
    return (
      "The opencode engine is not available to automation runs (this run carries deniedTools — " +
      "the automation least-privilege set). Use a claude-* or gpt-* model instead."
    );
  }
  const base = (opts.journal?.kind || "").replace(/(-(resume|rerun|fallback))+$/, "");
  if (!INTERACTIVE_KINDS.has(base)) {
    return `The opencode engine is not available to "${base}" runs — interactive sessions only.`;
  }
  return null;
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

/** Stop every managed `opencode serve` process (verify scripts / tests). */
export function killAllOpencodeServers(reason = "shutdown"): void {
  for (const [key, entry] of [...servers.entries()]) killServer(key, entry, reason);
}

function killServer(key: string, entry: OpencodeServerEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try {
    entry.proc.kill();
  } catch {}
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
  author?: GitIdentity | null
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
  author?: GitIdentity | null
): Promise<OpencodeServerEntry> {
  const configHash = Bun.hash(JSON.stringify(config) + "\n" + cwd).toString(16);
  const existing = servers.get(key);
  if (existing) {
    const alive = existing.proc.exitCode === null && !existing.proc.killed;
    if (alive && existing.configHash === configHash) return existing;
    killServer(key, existing, alive ? "config changed" : "process died");
  }
  return spawnOpencodeServer(key, cwd, config, configHash, author);
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

export async function* runOpencode(
  opts: RunAgentOpts,
  model: string
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

  try {
    // Bridge for Anthropic models — throws a clear config error when disabled.
    let providerOverride: Record<string, unknown> | undefined;
    if (parsed.providerID === "anthropic") {
      const bridge = ensureAnthropicBridge();
      providerOverride = {
        anthropic: { options: { baseURL: `${bridge.url}/v1`, apiKey: bridge.key } },
      };
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

    const ocConfig: Record<string, unknown> = {
      mcp: {
        ...externalMcp,
        ...(hasInProcess && journal?.bksSessionId
          ? proxyOpencodeMcpConfigs(opts.inProcessMcp, rpcToken)
          : {}),
      },
      instructions: [instructionsPath],
      autoshare: false,
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

    entry = await ensureOpencodeServer(serverKey, cwd, ocConfig, author);
    entry.rpcToken = rpcToken;
    entry.activeRuns++;
    entry.lastUsed = Date.now();
    if (hasInProcess && journal?.bksSessionId) {
      registerRunToken(rpcToken, { sessionId: journal.bksSessionId, user });
      rpcTokenRegistered = true;
    }

    const client = clientFor(entry);

    // Resolve/create the opencode session.
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
    }
    if (!registeredKeys.has(ocSessionId)) {
      registeredKeys.add(ocSessionId);
      activeOpencodeRuns.set(ocSessionId, abortController);
    }

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
    const push = (ev: StreamEvent) => {
      pending.push(ev);
      wake?.();
    };
    const signalDone = () => {
      idle = true;
      wake?.();
    };

    const handleEvent = async (ev: any) => {
      const p = ev?.properties;
      switch (ev?.type) {
        case "message.part.updated": {
          const part = p?.part;
          if (!part || part.sessionID !== ocSessionId) return;
          if (part.type === "text" && !part.synthetic && part.time?.end && !emittedText.has(part.id)) {
            emittedText.add(part.id);
            turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(part.text) });
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
      pumpStopped = true;
      void pump.catch(() => {});
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
      const limit = isCodexUsageLimitError(errMessage);
      turnEvent({ direction: "out", kind: "error", error: errMessage });
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
      yield {
        type: "error",
        content: message,
        provider: PROVIDER,
        model,
        usageLimitExhausted: isCodexUsageLimitError(message) || undefined,
      };
    }
  } finally {
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    for (const key of registeredKeys) activeOpencodeRuns.delete(key);
    if (rpcTokenRegistered && entry) unregisterRunToken(entry.rpcToken);
    if (entry) {
      entry.activeRuns = Math.max(0, entry.activeRuns - 1);
      entry.lastUsed = Date.now();
    }
    if (journal) journalClear(runKey);
  }
}
