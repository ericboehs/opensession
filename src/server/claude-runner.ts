import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync, existsSync } from "fs";
import { readMcpConfig } from "./connections";

const HOME = process.env.HOME || "/home/ubuntu";
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;

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
}): AsyncGenerator<StreamEvent> {
  const { prompt, sessionId, cwd, mode } = opts;
  const isAsk = mode === "ask";

  if (sessionId && isSessionBusy(sessionId)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }

  const abortController = new AbortController();
  const runKey = sessionId || crypto.randomUUID();
  activeRuns.set(runKey, abortController);

  try {
    const q = query({
      prompt,
      options: {
        resume: sessionId || undefined,
        cwd,
        allowedTools: isAsk
          ? [
              "Bash", "Read", "Grep", "Glob",
              "Task", "TaskOutput", "WebFetch", "WebSearch",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ]
          : [
              "Bash", "Read", "Edit", "Write", "Grep", "Glob",
              "Task", "TaskOutput", "WebFetch", "WebSearch",
              "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
              "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
            ],
        canUseTool: async (_toolName: string, input: Record<string, unknown>) => {
          return { behavior: "allow" as const, updatedInput: input };
        },
        // Read per run so MCP servers added/removed in the UI apply immediately
        mcpServers: readMcpConfig().mcpServers as any,
        strictMcpConfig: true,
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
  }
}
