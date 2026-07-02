/**
 * michael-sessions — an in-process MCP server that lets Michael see and steer
 * every other Backstage session from Slack: what's running, what's waiting on a
 * question, and the controls to answer / message / cancel / spin up sessions.
 *
 * Like michael-admin and michael-github, this is an in-process SDK MCP wired
 * ONLY into interactive Slack runs (handlers.ts processMessage). Its tools call
 * the session-control registry (src/server/session-control.ts), which backstage.ts
 * populates at startup with the same live state + helpers the WebSocket handlers
 * use — so steering a run from here behaves exactly like a human typing in the
 * web UI. It is never wired into automation runs (untrusted ticket text must not
 * be able to puppet other sessions).
 *
 * Gating: the read tools (list/get) are available to any whitelisted user who
 * can talk to Michael; the control tools (answer/send/cancel/create) are gated
 * to the trusted user via `isAdmin`, matching michael-admin.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  getSessionControl,
  type SessionState,
  type SessionSummary,
} from "../../server/session-control";
import type { TranscriptEntry } from "../../server/types";

export interface SessionsToolContext {
  /** Display name credited when this session messages/creates others. */
  createdBy: string;
  /** Trusted user — gates the control tools (answer/send/cancel/create). */
  isAdmin: boolean;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

const STATE_ICON: Record<SessionState, string> = {
  running: "🟢",
  waiting_question: "❓",
  queued: "⏳",
  idle: "⚪",
  archived: "🗄️",
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "?";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Pull the human-readable headers out of a pending AskUserQuestion. */
function questionHeaders(questions: unknown[]): string {
  return questions
    .map((q) => {
      const o = q as { header?: string; question?: string; options?: { label?: string }[] };
      const opts = (o.options || []).map((opt) => opt.label).filter(Boolean);
      const head = o.header || o.question || "question";
      return `“${head}”${opts.length ? ` (${opts.join(" / ")})` : ""}`;
    })
    .join(", ");
}

function oneLine(s: SessionSummary): string {
  const bits: string[] = [`${STATE_ICON[s.state]} *${s.title || "(untitled)"}*  \`${s.id}\``];
  const meta: string[] = [s.state];
  if (s.source) meta.push(s.source);
  if (s.mode) meta.push(s.mode);
  if (s.model) meta.push(s.model);
  if (s.branch) meta.push(`branch ${s.branch}`);
  if (s.startedBy) meta.push(`by ${s.startedBy}`);
  meta.push(relTime(s.lastActivity));
  if (!s.controllable) meta.push("observe-only");
  bits.push(`   ${meta.join(" · ")}`);
  if (s.prUrl) bits.push(`   PR ${s.prState || ""} ${s.prUrl}`.trimEnd());
  if (s.queuedCount > 0) bits.push(`   ${s.queuedCount} message(s) queued`);
  if (s.state === "waiting_question" && s.pendingQuestion) {
    bits.push(`   ⚠️ waiting on: ${questionHeaders(s.pendingQuestion.questions)}`);
  }
  return bits.join("\n");
}

function fmtTranscriptTail(entries: TranscriptEntry[]): string {
  if (!entries.length) return "_(no transcript yet)_";
  return entries
    .map((e) => {
      const who =
        e.type === "user"
          ? "user"
          : e.type === "assistant"
            ? "michael"
            : e.type === "tool_use"
              ? `tool:${e.toolName || "?"}`
              : e.type;
      const body = (e.content || "").replace(/\s+/g, " ").slice(0, 280);
      return `• ${who}: ${body}`;
    })
    .join("\n");
}

export function createSessionsMcpServer(ctx: SessionsToolContext) {
  const tools: any[] = [
    // -----------------------------------------------------------------------
    // Observe (any whitelisted user)
    // -----------------------------------------------------------------------
    tool(
      "list_sessions",
      "List all Backstage sessions with their live state (running / waiting_question / queued / idle / archived). Use filter 'waiting' to see only sessions blocked on a question (the ones that need a human), 'active' for running+waiting+queued, or 'all' (default, hides archived). This is the 'what's going on across all my sessions' view.",
      {
        filter: z
          .enum(["all", "active", "waiting"])
          .optional()
          .describe("'all' (default, excludes archived), 'active' (running/waiting/queued), or 'waiting' (blocked on a question)."),
      },
      async (args: { filter?: "all" | "active" | "waiting" }) => {
        const filter = args.filter || "all";
        let sessions = getSessionControl().listSessions();
        if (filter === "waiting") {
          sessions = sessions.filter((s) => s.state === "waiting_question");
        } else if (filter === "active") {
          sessions = sessions.filter((s) =>
            ["running", "waiting_question", "queued"].includes(s.state)
          );
        } else {
          sessions = sessions.filter((s) => s.state !== "archived");
        }
        if (!sessions.length) return text(`No ${filter === "all" ? "" : filter + " "}sessions.`);
        const waiting = sessions.filter((s) => s.state === "waiting_question").length;
        const header = `${sessions.length} session(s)${waiting ? ` — ⚠️ ${waiting} waiting on input` : ""}:`;
        return text([header, "", ...sessions.map(oneLine)].join("\n"));
      }
    ),
    tool(
      "get_session",
      "Get detail on one session by id: its state, any pending question (with the options to choose from), how many messages are queued, and the tail of its transcript so you can see what it's doing.",
      {
        id: z.string().describe("The session id, e.g. 'bks-…' or 'slack-…' from list_sessions."),
        transcript_lines: z
          .number()
          .optional()
          .describe("How many trailing transcript entries to include (default 12)."),
      },
      async (args: { id: string; transcript_lines?: number }) => {
        const ctrl = getSessionControl();
        const s = ctrl.getSession(args.id);
        if (!s) return text(`No session with id \`${args.id}\`.`);
        const parts = [oneLine(s)];
        if (s.goal) parts.push(`\n*Pinned goal:* ${s.goal}`);
        if (s.pendingQuestion) {
          parts.push(
            `\n*Waiting for an answer* (questionId \`${s.pendingQuestion.questionId}\`):\n` +
              questionHeaders(s.pendingQuestion.questions) +
              `\nUse answer_session_question to respond.`
          );
        }
        const tail = ctrl.transcriptTail(args.id, args.transcript_lines ?? 12);
        parts.push(`\n*Recent transcript:*\n${fmtTranscriptTail(tail)}`);
        return text(parts.join("\n"));
      }
    ),
  ];

  if (ctx.isAdmin) {
    tools.push(
      // ---------------------------------------------------------------------
      // Control (trusted user only)
      // ---------------------------------------------------------------------
      tool(
        "answer_session_question",
        "Answer a session that's paused on a question (state 'waiting_question'). Provide answers as a map from each question's header to the chosen option label (see get_session for the headers and options). This unblocks the run so it continues.",
        {
          id: z.string().describe("The waiting session's id."),
          answers: z
            .record(z.string(), z.string())
            .describe("Map of question header → chosen option label, e.g. { \"Auth method\": \"OAuth\" }."),
        },
        async (args: { id: string; answers: Record<string, string> }) => {
          const ok = getSessionControl().answerQuestion(args.id, args.answers);
          return text(
            ok
              ? `Answered \`${args.id}\` — the run continues with your choice.`
              : `\`${args.id}\` isn't waiting on a question right now.`
          );
        }
      ),
      tool(
        "send_to_session",
        "Send a message to another session. If it's mid-run it's folded into the current turn (picked up at the next stopping point); if it's idle it starts a new turn; external runs (CLI/tmux) get the message queued. Use this to redirect or follow up on a session without opening it. Slash commands are handled by backstage itself instead of being delivered as prompt text: `/loop <interval> <prompt>` sets a recurring self-prompt on the TARGET session (fires only while it is idle; min 5m), `/loop status` / `/loop stop` inspect or clear it — works on your own session id too, so a monitor session can stop its own loop when the work is done.",
        {
          id: z.string().describe("The target session's id."),
          message: z.string().describe("The message to deliver."),
        },
        async (args: { id: string; message: string }) => {
          if (!args.message?.trim()) return text("Nothing to send (empty message).");
          const res = await getSessionControl().deliverToSession(
            args.id,
            args.message,
            ctx.createdBy
          );
          return text(res.message);
        }
      ),
      tool(
        "cancel_session",
        "Cancel a session's in-flight run and drop any queued messages. Only works for runs this server owns (web UI / Slack / automation sessions) — external CLI/tmux sessions are observe-only.",
        { id: z.string().describe("The session id to cancel.") },
        async (args: { id: string }) => {
          const ok = getSessionControl().cancelSession(args.id);
          return text(
            ok
              ? `Cancelled the run on \`${args.id}\`.`
              : `Nothing to cancel on \`${args.id}\` (idle, or an external run this server doesn't own).`
          );
        }
      ),
      tool(
        "create_session",
        "Spin up a new Backstage session and start it on a prompt. mode 'ask' (default) runs read-only on the selected repo checkout — good for questions/investigations; mode 'code' creates or reuses a worktree on `branch` and can edit files / open PRs (never merges). Pass repo when the worker should run outside the default tella-fusion repo, for example repo: 'backstage'. Pass model 'gpt-5.5' or 'codex' for a Codex worker session when delegating clear implementation, bulk analysis, migrations, logs, or other token-hungry mechanical work from a Fable/Claude orchestrator. For workers that only need filesystem/code access, pass mcpServers: [] to avoid unrelated MCP startup cost/failures. The run starts in the background; the new session then shows up in list_sessions.",
        {
          prompt: z.string().describe("The task/prompt to start the session on."),
          repo: z
            .string()
            .optional()
            .describe("Registered repo id to run in, e.g. 'tella-fusion' or 'backstage'. Defaults to tella-fusion."),
          mode: z
            .enum(["ask", "code"])
            .optional()
            .describe("'ask' = read-only (default), 'code' = worktree with write access."),
          branch: z
            .string()
            .optional()
            .describe("Branch for the worktree (required for code mode; ignored for ask)."),
          model: z.string().optional().describe("Optional model id (e.g. 'claude-opus-4-8')."),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe("Optional MCP server allowlist for the opening run. Use [] for no MCP servers."),
        },
        async (args: {
          prompt: string;
          repo?: string;
          mode?: "ask" | "code";
          branch?: string;
          model?: string;
          mcpServers?: string[];
        }) => {
          if (!args.prompt?.trim()) return text("Need a prompt to start a session.");
          if (args.mode === "code" && !args.branch?.trim()) {
            return text("Code mode needs a `branch` for the worktree.");
          }
          const { id } = await getSessionControl().createSession({
            prompt: args.prompt,
            repo: args.repo,
            mode: args.mode,
            branch: args.branch,
            model: args.model,
            mcpServers: args.mcpServers,
            user: ctx.createdBy,
          });
          return text(
            `Started session \`${id}\` (${args.mode === "code" ? `code on ${args.branch}` : "ask"}). It'll appear in list_sessions as it boots.`
          );
        }
      )
    );
  }

  return createSdkMcpServer({
    name: "michael-sessions",
    version: "1.0.0",
    tools,
  });
}
