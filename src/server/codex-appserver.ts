/**
 * Codex app-server transport: drives Codex runs over `codex app-server`'s
 * JSON-RPC-over-stdio API instead of the exec-based @openai/codex-sdk
 * (codex-runner.ts). Same StreamEvent generator contract as runCodex/runClaude,
 * plus the two things exec fundamentally can't do:
 *
 *  - `turn/steer`: fold a user message into the RUNNING turn (verified live —
 *    a steered instruction lands in the same turn's final answer), so busy
 *    sends to Codex sessions steer like Claude ones instead of queueing.
 *  - `turn/interrupt`: abort the current turn in ~ms while keeping the thread
 *    usable — powering Esc-stop and interrupt-and-redirect.
 *
 * Compatibility (all verified against codex-cli 0.139):
 *  - Threads are the same rollouts exec writes; app-server resumes
 *    exec-created thread ids and vice versa (same CODEX_HOME), so switching
 *    transports mid-session keeps history. Transcript tailing keeps working —
 *    app-server appends to the same rollout files.
 *  - `developerInstructions` is a first-class param (no config-key hop),
 *    `config.mcp_servers` reaches the thread (stdio proxies + tool timeouts
 *    identical to the exec path), and `thread/tokenUsage/updated` gives
 *    per-turn usage plus the model's real context window.
 *
 * Opt-in: set `{"transport": "app-server"}` in ~/.backstage-codex-transport.json
 * (read per run) or MICHAEL_CODEX_TRANSPORT=app-server. Default stays exec.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { audit, summarizeText } from "./audit";
import {
  pickCodexAccount,
  markCodexExhausted,
  findCodexRollout,
  type CodexAccount,
} from "./codex-accounts";
import {
  journalSet,
  journalClear,
  type StreamEvent,
  type ImageInput,
} from "./claude-runner";
import {
  buildCodexDeveloperInstructions,
  buildCodexMcpNameMap,
  buildCodexMcpConfig,
  codexEnv,
  formatMcpAliasNote,
  isCodexUsageLimitError,
  normalizeCodexEffort,
  projectMcpServerNames,
  proxyMcpConfigs,
  runCodex,
  writeCodexImages,
} from "./codex-runner";
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { extractBackstageVideos } from "./jsonl-parser";
import { markCodexModelExhausted, priceUsageUsd, resolveConcreteModel } from "./models";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import type { GitIdentity } from "./shared/user-mappings";

const HOME = process.env.HOME || "/home/ubuntu";
const CODEX_BIN_FALLBACK = `${HOME}/projects/tella-backstage/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`;
const TRANSPORT_STORE = `${HOME}/.backstage-codex-transport.json`;

/** Which transport codex runs use. File wins (togglable at runtime), env is the fallback. */
export function codexTransport(): "exec" | "app-server" {
  try {
    if (existsSync(TRANSPORT_STORE)) {
      const raw = JSON.parse(readFileSync(TRANSPORT_STORE, "utf-8"));
      if (raw?.transport === "app-server") return "app-server";
      if (raw?.transport === "exec") return "exec";
    }
  } catch {}
  return process.env.MICHAEL_CODEX_TRANSPORT === "app-server" ? "app-server" : "exec";
}

/**
 * Transport-aware Codex entry point: one import for every caller (agent-runner
 * dispatch, Slack, Linear) so the exec ↔ app-server toggle applies everywhere.
 */
export function runCodexAuto(
  opts: Parameters<typeof runCodex>[0]
): AsyncGenerator<StreamEvent> {
  return codexTransport() === "app-server" ? runCodexAppServer(opts) : runCodex(opts);
}

function codexBinPath(): string {
  // The SDK's vendored binary — same one the exec transport runs.
  try {
    const pkg = require.resolve("@openai/codex-linux-x64/package.json");
    const path = pkg.replace(/package\.json$/, "vendor/x86_64-unknown-linux-musl/bin/codex");
    if (existsSync(path)) return path;
  } catch {}
  return CODEX_BIN_FALLBACK;
}

// Same run registry as the exec transport (globalThis-parked) so busy checks
// and cancelCodexRun work identically whichever transport drives the run.
const activeCodexRuns: Map<string, AbortController> = ((globalThis as any).__activeCodexRuns ??=
  new Map());

// Steer/interrupt controllers for in-flight app-server runs, keyed by every id
// a caller might hold (run key, thread id, backstage session id). Parked on
// globalThis so a hot reload keeps live runs steerable (see claude-runner's
// matching note on steerControllers).
type SteerFn = (text: string, images?: ImageInput[]) => boolean;
const codexSteerers: Map<string, SteerFn> = ((globalThis as any).__codexSteerControllers ??=
  new Map());
const codexInterruptSteerers: Map<string, SteerFn> = ((globalThis as any)
  .__codexInterruptSteerers ??= new Map());
const codexTurnStoppers: Map<string, () => boolean> = ((globalThis as any)
  .__codexTurnStoppers ??= new Map());

/** Steer a message into an in-flight app-server Codex run (merged into the RUNNING turn). */
export function codexSteerRun(id: string, text: string, images?: ImageInput[]): boolean {
  const steer = codexSteerers.get(id);
  return steer ? steer(text, images) : false;
}

/** Abort the current turn and continue immediately with the given message. */
export function codexInterruptAndSteerRun(
  id: string,
  text: string,
  images?: ImageInput[]
): boolean {
  const fn = codexInterruptSteerers.get(id);
  return fn ? fn(text, images) : false;
}

/** Esc-style stop: abort the current turn; the run winds down cleanly. */
export function codexStopRunTurn(id: string): boolean {
  const fn = codexTurnStoppers.get(id);
  return fn ? fn() : false;
}

// ── JSON-RPC client over the spawned app-server process ─────────────────────

interface RpcClient {
  proc: ChildProcessWithoutNullStreams;
  request: (method: string, params: unknown) => Promise<any>;
  onNotification: (fn: (method: string, params: any) => void) => void;
  kill: () => void;
}

function startAppServer(env: Record<string, string>): RpcClient {
  const proc = spawn(codexBinPath(), ["app-server"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let notify: (method: string, params: any) => void = () => {};
  let buf = "";

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        // Server→client REQUESTS (approvals etc.) would carry an id; with
        // approvalPolicy "never" none are expected — deny defensively so the
        // server never hangs awaiting us.
        if (msg.id !== undefined) {
          proc.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } }) + "\n"
          );
        }
        notify(msg.method, msg.params);
      }
    }
  });

  const fail = (why: string) => {
    const err = new Error(`codex app-server ${why}${stderrTail ? `: ${stderrTail.slice(-300)}` : ""}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  proc.on("exit", (code) => fail(`exited (code ${code})`));
  proc.on("error", (e) => fail(`spawn failed (${e.message})`));

  return {
    proc,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (proc.exitCode !== null) return reject(new Error("codex app-server not running"));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    onNotification: (fn) => {
      notify = fn;
    },
    kill: () => {
      try {
        proc.kill();
      } catch {}
    },
  };
}

// ── Item → StreamEvent mapping (v2 camelCase items) ──────────────────────────

export function describeAppServerToolUse(
  item: any
): { toolName: string; toolInput: unknown } | null {
  switch (item?.type) {
    case "commandExecution":
      return { toolName: "Bash", toolInput: { command: item.command } };
    case "mcpToolCall":
      return { toolName: `mcp__${item.server}__${item.tool}`, toolInput: item.arguments };
    case "dynamicToolCall":
      return { toolName: item.tool, toolInput: item.arguments };
    case "fileChange":
      return { toolName: "FileChange", toolInput: { changes: item.changes } };
    case "webSearch":
      return { toolName: "WebSearch", toolInput: { query: item.query } };
    default:
      return null;
  }
}

export function describeAppServerToolResult(item: any): string | null {
  switch (item?.type) {
    case "commandExecution":
      return `exit ${item.exitCode ?? "?"}\n${item.aggregatedOutput || ""}`;
    case "mcpToolCall": {
      if (item.error) return `Error: ${item.error.message}`;
      const content = item.result?.content;
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
      return item.status;
    }
    case "dynamicToolCall": {
      const content = item.contentItems;
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
      return item.status;
    }
    case "fileChange":
      return `${item.status}: ${(item.changes || [])
        .map((c: any) => `${c.kind} ${c.path}`)
        .join(", ")}`;
    default:
      return null;
  }
}

/**
 * Threads live inside one CODEX_HOME — mirror of codex-runner's accountCanResume.
 */
function accountCanResume(threadId: string, account?: CodexAccount): boolean {
  const owner = findCodexRollout(threadId);
  if (!owner) return false;
  if (owner.account) return owner.account.id === account?.id;
  return !account || account.kind === "api_key";
}

type TokenBreakdown = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export async function* runCodexAppServer(opts: {
  prompt: string;
  /** Codex thread id to resume; omit to start a new thread. */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  model: string;
  effort?: string;
  mcpServers?: string[];
  images?: ImageInput[];
  reposNote?: string;
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  fallbackModel?: string;
  journal?: { bksSessionId?: string; kind?: string };
  busyKeys?: string[];
  author?: GitIdentity | null;
  user?: string;
  inProcessMcp?: Record<string, unknown>;
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode, mcpServers, images, reposNote, deniedTools, confirmTools, fallbackModel, journal, busyKeys, author, user, inProcessMcp } = opts;
  const model = resolveConcreteModel(opts.model);
  const isAsk = mode === "ask";
  const effort = normalizeCodexEffort(opts.effort);

  const runKey = sessionId || journal?.bksSessionId || busyKeys?.[0] || crypto.randomUUID();
  if (activeCodexRuns.has(runKey)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const abortController = new AbortController();
  const registeredKeys = new Set<string>([runKey, ...(busyKeys || [])]);
  if (journal?.bksSessionId) registeredKeys.add(journal.bksSessionId);
  for (const key of registeredKeys) activeCodexRuns.set(key, abortController);

  const rpcToken =
    inProcessMcp && Object.keys(inProcessMcp).length && journal?.bksSessionId
      ? crypto.randomUUID()
      : undefined;
  if (rpcToken && journal?.bksSessionId) {
    registerRunToken(rpcToken, { sessionId: journal.bksSessionId, user });
  }

  const writeJournal = (engineId?: string) => {
    if (!journal) return;
    journalSet({
      runKey,
      bksSessionId: journal.bksSessionId,
      claudeSessionId: engineId || sessionId,
      prompt,
      cwd,
      mode,
      mcpServers,
      user,
      deniedTools,
      confirmTools,
      aws: false,
      model,
      effort: opts.effort,
      fallbackModel,
      kind: journal.kind,
      startedAt: new Date().toISOString(),
    });
  };
  writeJournal();

  const turnAuditId = crypto.randomUUID();
  let resultSessionId = sessionId || "";
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      provider: "codex",
      transport: "app-server",
      turn_id: turnAuditId,
      run_key: runKey,
      bks_session_id: journal?.bksSessionId,
      run_kind: journal?.kind,
      mode: mode || "code",
      claude_session_id: resultSessionId || undefined,
      model,
      ...fields,
    });

  const disabledToolNames = [
    ...Object.keys(deniedTools || {}),
    ...Object.keys(confirmTools || {}),
  ];
  const configuredMcp = withDynamicCredentials(readMcpConfig().mcpServers) as Record<string, any>;
  const requestedMcpNames = mcpServers ?? Object.keys(configuredMcp);
  const mcpAliases = buildCodexMcpNameMap(requestedMcpNames, projectMcpServerNames(cwd));
  const developerInstructions = buildCodexDeveloperInstructions({
    isAsk,
    reposNote,
    inProcessMcp,
    bksSessionId: journal?.bksSessionId,
    confirmTools,
    mcpAliasNote: formatMcpAliasNote(mcpAliases),
  });
  const codexImages = writeCodexImages(images);
  // Steer images get their own temp dirs, cleaned with the run.
  const steerImageCleanups: Array<() => void> = [];

  turnEvent({
    direction: "in",
    kind: "user_prompt",
    cwd,
    mcp_servers: mcpServers,
    denied_tools: disabledToolNames.length ? disabledToolNames : undefined,
    ...summarizeText(prompt),
  });

  const toInput = (text: string, imagePaths: string[] = []) => [
    { type: "text" as const, text, text_elements: [] },
    ...imagePaths.map((path) => ({ type: "localImage" as const, path })),
  ];

  let client: RpcClient | null = null;

  try {
    const triedAccountIds = new Set<string>();
    let account = pickCodexAccount(triedAccountIds, model);
    if (resultSessionId) {
      const owner = findCodexRollout(resultSessionId);
      if (owner?.account) {
        account = owner.account;
      } else if (owner && account?.kind === "home") {
        account = undefined; // thread lives in ~/.codex; home accounts can't see it
      } else if (!owner) {
        console.warn(
          `[codex-appserver] Thread ${resultSessionId} not found in any CODEX_HOME — starting a fresh thread`
        );
        resultSessionId = "";
      }
    }
    if (account) turnEvent({ direction: "out", kind: "account_used", account: account.name });

    for (;;) {
      let shouldRetryAfterSwitch = false;
      let finalResponse = "";

      // Per-run usage: latest breakdown per turn id, summed on emit (a run can
      // span several turns via interrupt-and-redirect).
      const turnUsage = new Map<string, TokenBreakdown>();
      const usageTotals = () => {
        let input = 0,
          cached = 0,
          output = 0;
        for (const u of turnUsage.values()) {
          input += u.inputTokens || 0;
          cached += u.cachedInputTokens || 0;
          output += u.outputTokens || 0;
        }
        return { input, cached, output };
      };
      let lastContextTokens = 0;

      try {
        client = startAppServer(codexEnv(account, author));
        const c = client;

        // Notification plumbing: an async queue the generator loop pulls from.
        const queue: Array<{ method: string; params: any }> = [];
        let wake: (() => void) | null = null;
        c.onNotification((method, params) => {
          queue.push({ method, params });
          wake?.();
          wake = null;
        });
        const nextNotification = async (): Promise<{ method: string; params: any } | null> => {
          for (;;) {
            if (queue.length) return queue.shift()!;
            if (abortController.signal.aborted || c.proc.exitCode !== null) return null;
            await new Promise<void>((r) => {
              wake = r;
              // Re-check periodically so an abort or process death can't strand us.
              setTimeout(r, 500);
            });
          }
        };

        await c.request("initialize", {
          clientInfo: { name: "backstage", title: "Michael Backstage", version: "1.0.0" },
          capabilities: null,
        });
        c.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");

        const threadParams = {
          cwd,
          model,
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          ...(developerInstructions ? { developerInstructions } : {}),
          config: {
            // Parity with Claude's WebSearch (server-side search tool).
            tools: { web_search: true },
            mcp_servers: {
              ...buildCodexMcpConfig(mcpServers, disabledToolNames, user, mcpAliases),
              ...proxyMcpConfigs(inProcessMcp, rpcToken),
            },
          },
        };
        const started = resultSessionId
          ? await c.request("thread/resume", { threadId: resultSessionId, ...threadParams })
          : await c.request("thread/start", threadParams);
        const threadId: string = started.thread.id;
        if (threadId !== resultSessionId) {
          resultSessionId = threadId;
          writeJournal(threadId);
        }
        if (!registeredKeys.has(threadId)) {
          registeredKeys.add(threadId);
          activeCodexRuns.set(threadId, abortController);
        }
        yield { type: "init", sessionId: threadId, provider: "codex", model };

        // Track the active turn for steer/interrupt preconditions.
        let currentTurnId = "";
        // Ref object (not a bare let): the value is written from steer/stop
        // closures, which TS's flow analysis can't see — a plain variable
        // narrows to `never` at the read site.
        const redirectRef: { current: { text: string; imagePaths: string[] } | null } = {
          current: null,
        };
        let stopRequested = false;

        const interruptCurrentTurn = () => {
          if (!currentTurnId) return false;
          void c
            .request("turn/interrupt", { threadId, turnId: currentTurnId })
            .catch(() => {});
          return true;
        };
        const steerImagePaths = (imgs?: ImageInput[]): string[] => {
          if (!imgs?.length) return [];
          const written = writeCodexImages(imgs);
          steerImageCleanups.push(written.cleanup);
          return written.paths;
        };
        for (const key of registeredKeys) {
          codexSteerers.set(key, (text, imgs) => {
            if (!currentTurnId) return false;
            void c
              .request("turn/steer", {
                threadId,
                expectedTurnId: currentTurnId,
                input: toInput(text, steerImagePaths(imgs)),
              })
              .then(() => {
                turnEvent({ direction: "in", kind: "steer", ...summarizeText(text) });
              })
              .catch((e) =>
                console.warn(`[codex-appserver] steer failed (turn may have ended):`, e?.message)
              );
            return true;
          });
          codexInterruptSteerers.set(key, (text, imgs) => {
            if (!currentTurnId) return false;
            redirectRef.current = { text, imagePaths: steerImagePaths(imgs) };
            return interruptCurrentTurn();
          });
          codexTurnStoppers.set(key, () => {
            if (!currentTurnId) return false;
            stopRequested = true;
            return interruptCurrentTurn();
          });
        }

        const startTurn = async (text: string, imagePaths: string[]) => {
          const res = await c.request("turn/start", {
            threadId,
            input: toInput(text, imagePaths),
            ...(effort ? { effort } : {}),
          });
          currentTurnId = res?.turn?.id || "";
        };
        await startTurn(prompt, codexImages.paths);

        // ── Drain notifications until the run's final turn ends ────────────
        for (;;) {
          const n = await nextNotification();
          if (abortController.signal.aborted) return;
          if (n === null) {
            if (client.proc.exitCode !== null) {
              throw new Error(`codex app-server exited mid-run (code ${client.proc.exitCode})`);
            }
            continue;
          }
          const { method, params } = n;

          if (method === "turn/started" && params?.turn?.id) {
            currentTurnId = params.turn.id;
          }

          if (method === "item/started") {
            const tool = describeAppServerToolUse(params?.item);
            if (tool) {
              turnEvent({
                direction: "out",
                kind: "tool_use",
                tool_name: tool.toolName,
                tool_use_id: params.item.id,
                ...summarizeText(JSON.stringify(tool.toolInput ?? {}), 500),
              });
              yield {
                type: "tool_use",
                toolName: tool.toolName,
                toolInput: tool.toolInput,
                toolUseId: params.item.id,
              };
            }
          }

          if (method === "item/completed") {
            const item = params?.item;
            if (item?.type === "agentMessage" && item.text) {
              finalResponse = item.text;
              turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(item.text) });
              yield { type: "text_chunk", text: item.text };
            }
            if (item?.type === "reasoning") {
              const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
              if (summary)
                turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(summary) });
            }
            const result = describeAppServerToolResult(item);
            if (result !== null) {
              const videos = extractBackstageVideos(result);
              turnEvent({
                direction: "in",
                kind: "tool_result",
                tool_use_id: item.id,
                ...summarizeText(result),
              });
              yield {
                type: "tool_result",
                toolUseId: item.id,
                content: result.length > 500 ? result.slice(0, 500) + "..." : result,
                ...(videos.length > 0 ? { videos } : {}),
              };
            }
          }

          if (method === "thread/tokenUsage/updated" && params?.tokenUsage?.last) {
            const last = params.tokenUsage.last as TokenBreakdown & { totalTokens?: number };
            turnUsage.set(params.turnId || currentTurnId || "turn", last);
            lastContextTokens = (last.inputTokens || 0) + (last.cachedInputTokens || 0);
            const t = usageTotals();
            yield {
              type: "usage_snapshot",
              usage: {
                costUsd: priceUsageUsd(model, {
                  input: t.input,
                  output: t.output,
                  cacheRead: t.cached,
                }),
                costApproximate: true,
                inputTokens: t.input,
                outputTokens: t.output,
                cacheReadTokens: t.cached,
                cacheCreationTokens: 0,
                contextTokens: lastContextTokens,
              },
            };
          }

          if (method === "turn/completed") {
            const status = params?.turn?.status;
            if (status === "interrupted" && redirectRef.current) {
              // Interrupt-and-redirect: continue this run with the new message.
              const redirect = redirectRef.current;
              redirectRef.current = null;
              turnEvent({ direction: "in", kind: "interrupt_steer", ...summarizeText(redirect.text) });
              await startTurn(redirect.text, redirect.imagePaths);
              continue;
            }
            currentTurnId = "";
            const t = usageTotals();
            turnEvent({
              direction: "out",
              kind: "result",
              result_subtype: status === "interrupted" ? "interrupted" : "success",
              is_error: false,
              input_tokens: t.input,
              output_tokens: t.output,
              cache_read_input_tokens: t.cached,
              ...summarizeText(finalResponse),
            });
            yield {
              type: "done",
              sessionId: threadId,
              result:
                finalResponse ||
                (status === "interrupted" || stopRequested
                  ? "(turn stopped)"
                  : "Done! (no text output)"),
              provider: "codex",
              model,
              usage: {
                costUsd: priceUsageUsd(model, {
                  input: t.input,
                  output: t.output,
                  cacheRead: t.cached,
                }),
                costApproximate: true,
                inputTokens: t.input,
                outputTokens: t.output,
                cacheReadTokens: t.cached,
                cacheCreationTokens: 0,
                contextTokens: lastContextTokens,
              },
            };
            return;
          }

          if (method === "turn/failed") {
            throw new Error(params?.turn?.error?.message || "turn failed");
          }
          if (method === "error" && params?.message) {
            // Non-fatal stream errors surface as items too; log only.
            console.warn(`[codex-appserver] error notification: ${params.message}`);
          }
        }
      } catch (e: any) {
        if (!abortController.signal.aborted && isCodexUsageLimitError(e?.message || String(e))) {
          if (account) {
            triedAccountIds.add(account.id);
            markCodexExhausted(account.id, model);
          }
          const next = pickCodexAccount(triedAccountIds, model);
          if (next && next.id !== account?.id) {
            account = next;
            turnEvent({ direction: "out", kind: "account_switch", account: next.name });
            if (resultSessionId && !accountCanResume(resultSessionId, next)) {
              console.warn(
                `[codex-appserver] Account ${next.name} can't resume thread ${resultSessionId}; starting fresh`
              );
              resultSessionId = "";
            }
            yield {
              type: "text_chunk",
              text: `\n\n[runner] Codex usage limit hit; switched to ${next.name} and retrying.\n\n`,
            };
            shouldRetryAfterSwitch = true;
          }
        }
        if (!shouldRetryAfterSwitch) throw e;
      } finally {
        client?.kill();
        client = null;
        for (const key of registeredKeys) {
          codexSteerers.delete(key);
          codexInterruptSteerers.delete(key);
          codexTurnStoppers.delete(key);
        }
      }

      if (!shouldRetryAfterSwitch) break;
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      const message = e.message || String(e);
      if (isCodexUsageLimitError(message)) markCodexModelExhausted(model);
      turnEvent({ direction: "out", kind: "error", error: message });
      yield {
        type: "error",
        content: message,
        provider: "codex",
        model,
        usageLimitExhausted: isCodexUsageLimitError(message) || undefined,
      };
    }
  } finally {
    codexImages.cleanup();
    for (const cleanup of steerImageCleanups) cleanup();
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    // (The inner finally already killed the app-server process.)
    for (const key of registeredKeys) {
      activeCodexRuns.delete(key);
      codexSteerers.delete(key);
      codexInterruptSteerers.delete(key);
      codexTurnStoppers.delete(key);
    }
    unregisterRunToken(rpcToken);
    if (journal) journalClear(runKey);
  }
}
