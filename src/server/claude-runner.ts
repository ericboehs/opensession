import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync, existsSync } from "fs";
import { readMcpConfig } from "./connections";

const HOME = process.env.HOME || "/home/ubuntu";
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
// Default model for all backstage-driven sessions (override via env)
const MODEL = process.env.MICHAEL_MODEL || "claude-fable-5";

export interface StreamEvent {
  type: "init" | "text_chunk" | "tool_use" | "tool_result" | "done" | "error";
  sessionId?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  content?: string;
  result?: string;
}

// Track active runs to prevent concurrent runs on same session
const activeRuns = new Map<string, AbortController>();

// Minimal environment for the spawned Claude process. Backstage's own env
// carries every API token and webhook secret from ~/.backstage.env; the agent
// child needs none of those — MCP servers get their credentials via
// mcp-config.json's per-server `env` (or load it themselves, like the
// workos-mcp wrapper). Only pass what the child needs to launch and run.
function childEnv(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    MICHAEL_MODEL: process.env.MICHAEL_MODEL,
  };
}

/** Resolve the MCP servers for a run: all configured, or just the allowlist. */
function filterMcpServers(allowlist?: string[]): Record<string, unknown> {
  const all = readMcpConfig().mcpServers;
  if (!allowlist) return all;
  const out: Record<string, unknown> = {};
  for (const name of allowlist) {
    if (all[name]) out[name] = all[name];
    else console.warn(`[runner] MCP allowlist names unknown server "${name}" — skipping`);
  }
  return out;
}

// ── Crash/restart journal ────────────────────────────────────
// Every in-flight run is recorded on disk; entries that survive a process
// restart are interrupted runs, which backstage resumes on boot.

const ACTIVE_RUNS_PATH = `${HOME}/.backstage-sessions/active-runs.json`;

export interface ActiveRunRecord {
  runKey: string;
  bksSessionId?: string;
  claudeSessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  mcpServers?: string[]; // per-run MCP allowlist, preserved across resume
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
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
    require("fs").writeFileSync(ACTIVE_RUNS_PATH, JSON.stringify(journal, null, 2));
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

function journalSet(record: ActiveRunRecord): void {
  const journal = readRunJournal();
  journal[record.runKey] = record;
  writeRunJournal(journal);
}

function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
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

export async function* runClaude(opts: {
  prompt: string;
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code";
  /**
   * MCP server allowlist for this run — only the named servers from
   * mcp-config.json are made available. Omitted = all configured servers
   * (interactive sessions). Automations should pass only what they use.
   */
  mcpServers?: string[];
  /**
   * Tools to hard-deny at the permission layer, mapping tool name → message
   * shown to the agent. Enforced in canUseTool, so it holds even if the
   * prompt (e.g. freeform ticket text) tries to talk the agent into it.
   */
  deniedTools?: Record<string, string>;
  journal?: { bksSessionId?: string; kind?: string };
  onAskUser?: (input: Record<string, unknown>) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  >;
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode, mcpServers, deniedTools, journal, onAskUser } = opts;
  const isAsk = mode === "ask";

  if (sessionId && isSessionBusy(sessionId)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const abortController = new AbortController();
  const runKey = sessionId || crypto.randomUUID();
  activeRuns.set(runKey, abortController);
  journalSet({
    runKey,
    bksSessionId: journal?.bksSessionId,
    claudeSessionId: sessionId,
    cwd,
    mode,
    mcpServers,
    deniedTools,
    kind: journal?.kind,
    startedAt: new Date().toISOString(),
  });

  try {
    const q = query({
      prompt,
      options: {
        resume: sessionId || undefined,
        cwd,
        model: MODEL,
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
            return { behavior: "deny" as const, message: deniedTools[toolName] };
          }
          if (toolName === "AskUserQuestion") {
            if (onAskUser) {
              try {
                return await onAskUser(input);
              } catch (e: any) {
                return {
                  behavior: "deny" as const,
                  message: `Question UI failed (${e?.message || e}) — decide yourself and note the assumption.`,
                };
              }
            }
            // Headless runs (automations) have nobody to answer
            return {
              behavior: "deny" as const,
              message:
                "This run is headless — nobody can answer questions. Use your best judgment, note the open question and your assumption in your final output.",
            };
          }
          return { behavior: "allow" as const, updatedInput: input };
        },
        // Read per run so MCP servers added/removed in the UI apply immediately
        mcpServers: filterMcpServers(mcpServers) as any,
        strictMcpConfig: true,
        env: childEnv(),
        pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude",
        executable: "bun",
        abortController,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          ...(isAsk
            ? {
                append:
                  "You are Michael in Ask mode: answer questions about the tella-fusion codebase. " +
                  "This is a READ-ONLY session on the main checkout — never modify, create, or delete " +
                  "files, never commit, never run state-changing commands. Explore with Read/Grep/Glob " +
                  "and read-only git commands, then answer clearly and concisely.",
              }
            : {}),
        },
        settingSources: ["user", "project"],
      },
    });

    let resultSessionId = sessionId || "";

    for await (const msg of q) {
      if (abortController.signal.aborted) break;

      if (msg.type === "system" && (msg as any).subtype === "init") {
        resultSessionId = (msg as any).session_id;
        journalSet({
          runKey,
          bksSessionId: journal?.bksSessionId,
          claudeSessionId: resultSessionId,
          cwd,
          mode,
          mcpServers,
          deniedTools,
          kind: journal?.kind,
          startedAt: new Date().toISOString(),
        });
        yield { type: "init", sessionId: resultSessionId };
      }

      if (msg.type === "assistant" && (msg as any).message?.content) {
        const content = (msg as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              yield { type: "text_chunk", text: block.text };
            }
            if (block.type === "tool_use") {
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
              yield {
                type: "tool_result",
                toolUseId: block.tool_use_id,
                content: text.length > 500 ? text.slice(0, 500) + "..." : text,
              };
            }
          }
        }
      }

      if (msg.type === "result") {
        const rm = msg as any;
        resultSessionId = rm.session_id || resultSessionId;
        yield {
          type: "done",
          sessionId: resultSessionId,
          result: rm.subtype === "success" ? rm.result : `Error: ${rm.errors?.join(", ") || "Unknown"}`,
        };
      }
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      yield { type: "error", content: e.message || String(e) };
    }
  } finally {
    activeRuns.delete(runKey);
    journalClear(runKey);
  }
}

/**
 * Resume runs that a previous process left in-flight (service restart or
 * crash). Each resumable run gets a continuation prompt against its Claude
 * session; the transcript file-watcher keeps any open viewers up to date.
 */
export function resumeInterruptedRuns(onResumed?: (bksSessionId?: string) => void): number {
  const interrupted = takeInterruptedRuns();
  let resumed = 0;

  for (const run of interrupted) {
    if (!run.claudeSessionId) {
      console.warn(
        `[runner] Interrupted run ${run.runKey} (${run.kind || "unknown"}) had no Claude session yet — cannot resume`
      );
      continue;
    }
    resumed++;
    console.log(
      `[runner] Resuming interrupted ${run.kind || "run"} ${run.bksSessionId || run.runKey} (started ${run.startedAt})`
    );
    void (async () => {
      try {
        for await (const event of runClaude({
          prompt:
            "This session was interrupted by a Michael service restart mid-run. " +
            "Review what you had already done, pick up where you left off, and finish the task. " +
            "If the work was actually complete, just post the final summary/answer.",
          sessionId: run.claudeSessionId,
          cwd: run.cwd,
          mode: run.mode,
          mcpServers: run.mcpServers,
          deniedTools: run.deniedTools,
          journal: { bksSessionId: run.bksSessionId, kind: `${run.kind || "run"}-resume` },
        })) {
          if (event.type === "done" || event.type === "error") {
            onResumed?.(run.bksSessionId);
          }
        }
      } catch (e) {
        console.error(`[runner] Resume failed for ${run.runKey}:`, e);
      }
    })();
  }

  return resumed;
}
