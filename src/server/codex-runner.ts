/**
 * Codex runner: the OpenAI-side sibling of claude-runner.ts.
 *
 * Wraps @openai/codex-sdk threads in the same StreamEvent generator shape, so
 * everything downstream (backstage WS streaming, automations, Slack) can run a
 * GPT/Codex model without caring which backend serves it. Threads persist in
 * ~/.codex/sessions (or the picked account's CODEX_HOME) and resume by id —
 * the codex thread id is stored wherever the claude session id would be
 * (BackstageSessionFile.codexThreadId, SlackSession.codexThreadId).
 *
 * Permission model differences vs the Claude runner:
 *  - No canUseTool hook exists, so `deniedTools` (mcp__server__tool names) are
 *    enforced via per-server `disabled_tools` in the MCP config — the tool is
 *    simply not exposed to the agent.
 *  - `confirmTools` (per-call human approval, e.g. money-moving Stripe) have
 *    no approval bridge on Codex, so they're disabled the same way. The agent
 *    is told to propose such actions instead.
 *  - ask mode → read-only sandbox; code mode → workspace-write with network.
 */

import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { audit, summarizeText } from "./audit";
import {
  pickCodexAccount,
  markCodexExhausted,
  findCodexRollout,
  type CodexAccount,
} from "./codex-accounts";
import { journalSet, journalClear, type StreamEvent } from "./claude-runner";
import { gitIdentityEnv, type GitIdentity } from "./shared/user-mappings";

const HOME = process.env.HOME || "/home/ubuntu";

// Active runs, keyed by codex thread id AND the backstage session id (both
// resolve for busy checks / cancellation, since a brand-new thread has no
// thread id until the first event).
// Parked on globalThis so a `bun --hot` reload keeps runs tracked (see the
// matching note in claude-runner.ts).
const activeCodexRuns: Map<string, AbortController> = ((globalThis as any).__activeCodexRuns ??=
  new Map());

export function isCodexSessionBusy(id: string): boolean {
  return activeCodexRuns.has(id);
}

/** Number of Codex runs this process is actively driving (for shutdown drain). */
export function activeCodexRunCount(): number {
  return activeCodexRuns.size;
}

export function cancelCodexRun(id: string): boolean {
  const ac = activeCodexRuns.get(id);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

function isCodexUsageLimitError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("429") ||
    s.includes("usage limit") ||
    (s.includes("limit") && s.includes("reached")) ||
    s.includes("too many requests")
  );
}

/**
 * Build the Codex `mcp_servers` config from mcp-config.json. Claude-style
 * entries map almost 1:1: stdio servers keep command/args/env, http servers
 * become `url` servers. Tool denials become per-server disabled_tools.
 */
function buildCodexMcpConfig(
  allowlist: string[] | undefined,
  disabledToolNames: string[]
): Record<string, Record<string, unknown>> {
  const all = withDynamicCredentials(readMcpConfig().mcpServers) as Record<string, any>;
  const names = allowlist ?? Object.keys(all);

  // mcp__<server>__<tool> → { server: [tool, ...] }
  const disabledByServer = new Map<string, string[]>();
  for (const full of disabledToolNames) {
    const m = full.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (!m) continue;
    const list = disabledByServer.get(m[1]) || [];
    list.push(m[2]);
    disabledByServer.set(m[1], list);
  }

  const out: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    const server = all[name];
    if (!server) {
      if (allowlist) console.warn(`[codex-runner] MCP allowlist names unknown server "${name}" — skipping`);
      continue;
    }
    const entry: Record<string, unknown> = {};
    if (server.type === "http" || server.url) {
      entry.url = server.url;
    } else {
      entry.command = server.command;
      if (server.args) entry.args = server.args;
      if (server.env) entry.env = server.env;
    }
    const disabled = disabledByServer.get(name);
    if (disabled?.length) entry.disabled_tools = disabled;
    out[name] = entry;
  }
  return out;
}

/**
 * Threads live inside one CODEX_HOME, so only the account whose dir holds the
 * rollout file (or, for ~/.codex threads, an api_key/no account) can resume it.
 */
function accountCanResume(threadId: string, account?: CodexAccount): boolean {
  const owner = findCodexRollout(threadId);
  if (!owner) return false;
  if (owner.account) return owner.account.id === account?.id;
  return !account || account.kind === "api_key";
}

/** Minimal env for the codex child process (mirrors claude-runner childEnv). */
function codexEnv(account?: CodexAccount, author?: GitIdentity | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME,
    LANG: process.env.LANG || "en_US.UTF-8",
    // Attribute commits this run makes to the prompt's author (empty otherwise).
    ...gitIdentityEnv(author),
  };
  if (account?.kind === "home") env.CODEX_HOME = account.value;
  return env;
}

function describeToolUse(item: ThreadItem): { toolName: string; toolInput: unknown } | null {
  switch (item.type) {
    case "command_execution":
      return { toolName: "Bash", toolInput: { command: item.command } };
    case "mcp_tool_call":
      return { toolName: `mcp__${item.server}__${item.tool}`, toolInput: item.arguments };
    case "file_change":
      return {
        toolName: "FileChange",
        toolInput: { changes: item.changes.map((c) => `${c.kind} ${c.path}`) },
      };
    case "web_search":
      return { toolName: "WebSearch", toolInput: { query: item.query } };
    default:
      return null;
  }
}

function describeToolResult(item: ThreadItem): string | null {
  switch (item.type) {
    case "command_execution":
      return `exit ${item.exit_code ?? "?"}\n${item.aggregated_output || ""}`;
    case "mcp_tool_call": {
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
    case "file_change":
      return `${item.status}: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}`;
    default:
      return null;
  }
}

export async function* runCodex(opts: {
  prompt: string;
  /** Codex thread id to resume; omit to start a new thread. */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  model: string;
  /** MCP server allowlist (same semantics as the Claude runner). */
  mcpServers?: string[];
  /** Enforced as per-server disabled_tools — the agent never sees them. */
  deniedTools?: Record<string, string>;
  /** No approval bridge on Codex: treated like deniedTools. */
  confirmTools?: Record<string, string>;
  /**
   * Crash/restart journal entry. Omit for callers with their own replay
   * mechanism (the Slack queue re-delivers interrupted messages itself).
   */
  journal?: { bksSessionId?: string; kind?: string };
  /** Extra ids to register for busy checks / cancellation (e.g. slack-<key>). */
  busyKeys?: string[];
  /** Git identity for commits this run makes (attributes them to the prompt's author). */
  author?: GitIdentity | null;
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode, model, mcpServers, deniedTools, confirmTools, journal, busyKeys, author } = opts;
  const isAsk = mode === "ask";

  const runKey = sessionId || journal?.bksSessionId || busyKeys?.[0] || crypto.randomUUID();
  if (activeCodexRuns.has(runKey)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const abortController = new AbortController();
  const registeredKeys = new Set<string>([runKey, ...(busyKeys || [])]);
  if (journal?.bksSessionId) registeredKeys.add(journal.bksSessionId);
  for (const key of registeredKeys) activeCodexRuns.set(key, abortController);

  if (journal) {
    journalSet({
      runKey,
      bksSessionId: journal.bksSessionId,
      claudeSessionId: sessionId,
      cwd,
      mode,
      mcpServers,
      deniedTools,
      model,
      kind: journal.kind,
      startedAt: new Date().toISOString(),
    });
  }

  const turnId = crypto.randomUUID();
  let resultSessionId = sessionId || "";
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      provider: "codex",
      turn_id: turnId,
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

  let effectivePrompt = prompt;
  if (Object.keys(confirmTools || {}).length > 0) {
    effectivePrompt +=
      "\n\n[Run policy: money-moving tools (refunds, subscription changes) are not available in this run. " +
      "If such an action is needed, describe the exact action and parameters in your output for a human to execute.]";
  }

  turnEvent({
    direction: "in",
    kind: "user_prompt",
    cwd,
    mcp_servers: mcpServers,
    denied_tools: disabledToolNames.length ? disabledToolNames : undefined,
    ...summarizeText(prompt),
  });

  try {
    const triedAccountIds = new Set<string>();
    let account = pickCodexAccount(triedAccountIds);

    // Resuming: pin the account that owns the thread's CODEX_HOME — any other
    // account literally can't see the thread file.
    if (resultSessionId) {
      const owner = findCodexRollout(resultSessionId);
      if (owner?.account) {
        account = owner.account;
      } else if (owner && account?.kind === "home") {
        // Thread lives in ~/.codex; home-kind accounts can't see it
        account = undefined;
      } else if (!owner) {
        console.warn(
          `[codex-runner] Thread ${resultSessionId} not found in any CODEX_HOME — starting a fresh thread`
        );
        resultSessionId = "";
      }
    }
    if (account) turnEvent({ direction: "out", kind: "account_used", account: account.name });

    for (;;) {
      let shouldRetryAfterSwitch = false;

      const codex = new Codex({
        env: codexEnv(account, author),
        ...(account?.kind === "api_key" ? { apiKey: account.value } : {}),
        config: {
          mcp_servers: buildCodexMcpConfig(mcpServers, disabledToolNames) as any,
        },
      });

      const threadOptions = {
        model,
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode: isAsk ? ("read-only" as const) : ("workspace-write" as const),
        approvalPolicy: "never" as const,
        ...(isAsk ? {} : { networkAccessEnabled: true }),
      };

      const thread = resultSessionId
        ? codex.resumeThread(resultSessionId, threadOptions)
        : codex.startThread(threadOptions);

      let finalResponse = "";

      try {
        const { events } = await thread.runStreamed(effectivePrompt, {
          signal: abortController.signal,
        });

        for await (const event of events as AsyncGenerator<ThreadEvent>) {
          if (abortController.signal.aborted) break;

          if (event.type === "thread.started") {
            resultSessionId = event.thread_id;
            if (!registeredKeys.has(resultSessionId)) {
              registeredKeys.add(resultSessionId);
              activeCodexRuns.set(resultSessionId, abortController);
            }
            if (journal) {
              journalSet({
                runKey,
                bksSessionId: journal.bksSessionId,
                claudeSessionId: resultSessionId,
                cwd,
                mode,
                mcpServers,
                deniedTools,
                model,
                kind: journal.kind,
                startedAt: new Date().toISOString(),
              });
            }
            yield { type: "init", sessionId: resultSessionId, provider: "codex", model };
          }

          if (event.type === "item.started") {
            const tool = describeToolUse(event.item);
            if (tool) {
              turnEvent({
                direction: "out",
                kind: "tool_use",
                tool_name: tool.toolName,
                tool_use_id: event.item.id,
                ...summarizeText(JSON.stringify(tool.toolInput ?? {}), 500),
              });
              yield {
                type: "tool_use",
                toolName: tool.toolName,
                toolInput: tool.toolInput,
                toolUseId: event.item.id,
              };
            }
          }

          if (event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message" && item.text) {
              finalResponse = item.text;
              turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(item.text) });
              yield { type: "text_chunk", text: item.text };
            }
            if (item.type === "reasoning" && item.text) {
              turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(item.text) });
            }
            if (item.type === "error") {
              turnEvent({ direction: "out", kind: "item_error", error: item.message });
            }
            const result = describeToolResult(item);
            if (result !== null) {
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
              };
            }
          }

          if (event.type === "turn.completed") {
            turnEvent({
              direction: "out",
              kind: "result",
              result_subtype: "success",
              is_error: false,
              input_tokens: event.usage?.input_tokens,
              output_tokens: event.usage?.output_tokens,
              cache_read_input_tokens: event.usage?.cached_input_tokens,
              ...summarizeText(finalResponse),
            });
            yield {
              type: "done",
              sessionId: resultSessionId,
              result: finalResponse || "Done! (no text output)",
              provider: "codex",
              model,
            };
            return;
          }

          if (event.type === "turn.failed" || event.type === "error") {
            const message =
              event.type === "turn.failed" ? event.error.message : event.message;
            throw new Error(message);
          }
        }

        // Aborted mid-stream or the stream ended without turn.completed
        if (abortController.signal.aborted) return;
        yield {
          type: "done",
          sessionId: resultSessionId,
          result: finalResponse || "Done! (no text output)",
          provider: "codex",
          model,
        };
        return;
      } catch (e: any) {
        if (!abortController.signal.aborted && isCodexUsageLimitError(e?.message || String(e))) {
          if (account) {
            triedAccountIds.add(account.id);
            markCodexExhausted(account.id);
          }
          const next = pickCodexAccount(triedAccountIds);
          // Without a pool there's nothing to rotate to; with one, retry until empty
          if (next && next.id !== account?.id) {
            account = next;
            turnEvent({ direction: "out", kind: "account_switch", account: next.name });
            if (resultSessionId && !accountCanResume(resultSessionId, next)) {
              // The thread file lives in the exhausted account's CODEX_HOME —
              // the new account starts a fresh thread in the same cwd.
              console.warn(
                `[codex-runner] Account ${next.name} can't resume thread ${resultSessionId}; starting fresh`
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
        provider: "codex",
        model,
        // Reaching here on a limit error means rotation found no account left
        usageLimitExhausted: isCodexUsageLimitError(message) || undefined,
      };
    }
  } finally {
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    for (const key of registeredKeys) activeCodexRuns.delete(key);
    if (journal) journalClear(runKey);
  }
}
