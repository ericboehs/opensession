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
 * can talk to Michael; the control tools (answer/send/cancel/create, and the
 * spawn_task/task_status/cancel_task task primitives) are gated to the trusted
 * user via `isAdmin`, matching michael-admin.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import {
  getSessionControl,
  type SessionControl,
  type SessionState,
  type SessionSummary,
} from "../../server/session-control";
import { BACKSTAGE_CHATS_DIR } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { migrateSessionEngine } from "../../server/migrate-engine";
import type { BackstageSessionFile, TranscriptEntry } from "../../server/types";

export interface SessionsToolContext {
  /** Display name credited when this session messages/creates others. */
  createdBy: string;
  /** Trusted user — gates the control tools (answer/send/cancel/create). */
  isAdmin: boolean;
  /** The session using these tools, so worker sessions can report back to it. */
  currentSessionId?: string;
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
  if (s.parentSessionId) meta.push(`child of ${s.parentSessionId}`);
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

export function buildChildSessionPrompt(input: {
  prompt: string;
  parentSessionId?: string;
  reportBack?: boolean;
}): string {
  const parts = [
    input.prompt.trim(),
    "You are a worker session delegated by another Michael session. Keep the work narrow: execute the requested investigation/implementation, run relevant checks when practical, and produce a concise result with files changed, commands run, findings, and any blockers. Do not broaden scope or make product/taste decisions unless explicitly asked.",
  ];
  if (input.reportBack && input.parentSessionId) {
    parts.push(
      `When finished, report back to the parent/orchestrator session \`${input.parentSessionId}\` using the michael-sessions send_to_session tool. Send a concise handoff with: outcome, important files/links, tests/checks run, and any follow-up needed.`
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// spawn_task / task_status / cancel_task — the fire-and-forget child-task
// primitive (background-agents' spawn-task pattern). spawn_task rides the SAME
// SessionControl.createSession code path as create_session (never a parallel
// implementation); what it adds is the task contract: return {taskId, url}
// immediately, poll with task_status, stop with cancel_task — plus a spawn-
// depth loop guard and an automation refusal (defense-in-depth: michael-
// sessions is never wired into automation runs in the first place; backstage.ts
// gates inProcessMcp on !isAutomationSession and admin-tools/handlers wire it
// only for interactive Slack runs).
// ---------------------------------------------------------------------------

/** A session at this spawn depth may not spawn further (root = 0, so one
 *  spawned child may spawn one grandchild; the grandchild is the floor). */
export const MAX_SPAWN_DEPTH = 2;

/** Injection seam so the depth guard / automation refusal / file stamping are
 *  unit-testable without a live server or real session files. */
export interface SpawnTaskDeps {
  control: SessionControl;
  /** Read a backstage session file by id; null when absent/unreadable. */
  readSessionFile: (id: string) => Partial<BackstageSessionFile> | null;
  /** Persist spawnDepth onto the child's session file (async, best-effort). */
  stampSpawnDepth: (id: string, depth: number) => void | Promise<void>;
}

function defaultReadSessionFile(id: string): Partial<BackstageSessionFile> | null {
  try {
    const path = `${BACKSTAGE_CHATS_DIR}/${id}.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Persist spawnDepth on the child's session file. The file is first written at
 * the opening run's `init` event (backstage.ts persist(), which builds it from
 * scratch — anything written earlier would be clobbered), so poll until it
 * exists and then MERGE the field; every later update goes through
 * touchBackstageSession-style merges, so it sticks. The in-memory depth map
 * (below) covers the guard in the meantime.
 */
async function defaultStampSpawnDepth(id: string, depth: number): Promise<void> {
  const path = `${BACKSTAGE_CHATS_DIR}/${id}.json`;
  for (let i = 0; i < 240; i++) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (data?.id) {
          if (data.spawnDepth !== depth) writeJsonAtomic(path, { ...data, spawnDepth: depth });
          return;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[spawn_task] could not stamp spawnDepth on ${id} — session file never appeared`);
}

function defaultSpawnDeps(): SpawnTaskDeps {
  return {
    control: getSessionControl(),
    readSessionFile: defaultReadSessionFile,
    stampSpawnDepth: defaultStampSpawnDepth,
  };
}

/** Depths of children spawned by THIS process, so the guard holds in the
 *  window before the child's session file exists (parked on globalThis to
 *  survive `bun --hot` reloads, capped so it never grows unbounded). */
function spawnDepthMap(): Map<string, number> {
  const g = globalThis as { __bksSpawnDepths?: Map<string, number> };
  return (g.__bksSpawnDepths ??= new Map());
}

/** A session's spawn depth: session file first (authoritative + fresh), then
 *  the in-process map (pre-init window), then the control registry's summary. */
export function resolveSpawnDepth(
  sessionId: string | undefined,
  deps: Pick<SpawnTaskDeps, "control" | "readSessionFile">,
): number {
  if (!sessionId) return 0;
  const file = deps.readSessionFile(sessionId);
  if (typeof file?.spawnDepth === "number") return file.spawnDepth;
  const mem = spawnDepthMap().get(sessionId);
  if (typeof mem === "number") return mem;
  try {
    const s = deps.control.getSession(sessionId);
    if (typeof s?.spawnDepth === "number") return s.spawnDepth;
  } catch {}
  return 0;
}

function isAutomationOwned(
  sessionId: string,
  deps: Pick<SpawnTaskDeps, "control" | "readSessionFile">,
): boolean {
  const file = deps.readSessionFile(sessionId);
  if (file?.automation) return true;
  if (file?.createdBy?.endsWith(" (automation)")) return true;
  try {
    return Boolean(deps.control.getSession(sessionId)?.automation);
  } catch {
    return false;
  }
}

export interface SpawnTaskArgs {
  prompt: string;
  repo?: string;
  branch?: string;
  model?: string;
  mode?: "ask" | "code";
  /** true = config default provider; or an explicit configured provider id. */
  sandbox?: boolean | "docker" | "daytona" | "e2b";
}

export type SpawnTaskResult =
  | { ok: true; taskId: string; url: string }
  | { ok: false; error: string };

export async function spawnTaskImpl(
  args: SpawnTaskArgs,
  ctx: SessionsToolContext,
  deps: SpawnTaskDeps = defaultSpawnDeps(),
): Promise<SpawnTaskResult> {
  if (!args.prompt?.trim()) return { ok: false, error: "Need a prompt to spawn a task." };
  const mode = args.mode || "code";
  const caller = ctx.currentSessionId;
  // Defense-in-depth: michael-sessions is withheld from automation runs at the
  // wiring layer already; refuse anyway if the calling session is
  // automation-owned (interactive resumes of automation sessions included).
  if (caller && isAutomationOwned(caller, deps)) {
    return { ok: false, error: "spawn_task is not available from automation sessions." };
  }
  const myDepth = resolveSpawnDepth(caller, deps);
  if (myDepth >= MAX_SPAWN_DEPTH) {
    return {
      ok: false,
      error:
        `spawn_task refused: this session is already ${myDepth} spawn hops from a human-created session ` +
        `(max ${MAX_SPAWN_DEPTH}). Do the work here, or report back to your parent instead of delegating further.`,
    };
  }
  // Code mode needs somewhere to work: an explicit branch, or a parent code
  // session whose worktree the child will share (createSession's same-
  // workspace = same-worktree rule; only when the repo matches).
  if (mode === "code" && !args.branch?.trim()) {
    let sharable = false;
    if (caller) {
      try {
        const parent = deps.control.getSession(caller);
        sharable = Boolean(
          parent && parent.mode === "code" && parent.worktreeDir &&
            (!args.repo || args.repo === parent.repo),
        );
      } catch {}
    }
    if (!sharable) {
      return { ok: false, error: "Code-mode task needs a `branch` (no parent code worktree to share)." };
    }
  }
  const prompt = buildChildSessionPrompt({
    prompt: args.prompt,
    parentSessionId: caller,
    reportBack: Boolean(caller),
  });
  const { id } = await deps.control.createSession({
    prompt,
    repo: args.repo,
    mode,
    branch: args.branch,
    model: args.model,
    parentSessionId: caller,
    reportBack: Boolean(caller),
    user: ctx.createdBy,
    sandbox: args.sandbox,
  });
  const depth = myDepth + 1;
  const map = spawnDepthMap();
  map.set(id, depth);
  if (map.size > 500) map.delete(map.keys().next().value!);
  void Promise.resolve(deps.stampSpawnDepth(id, depth)).catch((e) =>
    console.warn(`[spawn_task] stamping spawnDepth on ${id} failed:`, e),
  );
  const base = process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";
  return { ok: true, taskId: id, url: `${base}/session/${id}` };
}

/** Task-facing state view: running / waiting (blocked on a question) / done /
 *  error (last run died on a terminal failure). */
export function taskStateOf(s: SessionSummary): "running" | "waiting" | "done" | "error" {
  if (s.state === "running" || s.state === "queued") return "running";
  if (s.state === "waiting_question") return "waiting";
  return s.lastRunError ? "error" : "done";
}

export async function taskStatusImpl(
  args: { taskId: string; transcript_lines?: number },
  deps: SpawnTaskDeps = defaultSpawnDeps(),
): Promise<string> {
  const s = deps.control.getSession(args.taskId);
  if (!s) return `No task/session with id \`${args.taskId}\`.`;
  const state = taskStateOf(s);
  const parts = [`Task \`${s.id}\` — *${state}* (${s.state})`, oneLine(s)];
  if (state === "error" && s.lastRunError) parts.push(`*Error:* ${s.lastRunError.message}`);
  if (s.state === "waiting_question" && s.pendingQuestion) {
    parts.push(
      `*Waiting on:* ${questionHeaders(s.pendingQuestion.questions)} — answer with answer_session_question (questionId \`${s.pendingQuestion.questionId}\`).`,
    );
  }
  if (s.prUrl) parts.push(`*PR:* ${s.prState || ""} ${s.prUrl}`.trim());
  // Diff stat — host-side worktrees only (a volume-mode sandbox workspace has
  // no host dir; skip rather than wake its container for a status read).
  if (s.mode === "code" && s.worktreeDir && existsSync(s.worktreeDir)) {
    try {
      const [{ getSessionDiff }, { getRepo }] = await Promise.all([
        import("../../server/git-diff"),
        import("../../server/worktree"),
      ]);
      const diff = await getSessionDiff(s.worktreeDir, getRepo(s.repo).defaultBranch);
      if (diff.files.length) {
        parts.push(`*Diff:* ${diff.files.length} file(s) changed, +${diff.totalAdditions}/-${diff.totalDeletions}`);
      }
    } catch {}
  }
  const tail = deps.control.transcriptTail(args.taskId, args.transcript_lines ?? 12);
  parts.push(`*Recent transcript:*\n${fmtTranscriptTail(tail)}`);
  return parts.join("\n");
}

export function cancelTaskImpl(
  args: { taskId: string },
  deps: SpawnTaskDeps = defaultSpawnDeps(),
): string {
  const ok = deps.control.cancelSession(args.taskId);
  return ok
    ? `Cancelled task \`${args.taskId}\`.`
    : `Nothing to cancel on \`${args.taskId}\` (idle, done, or an external run this server doesn't own).`;
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
        "Spin up a visible Backstage session and start it on a prompt. Use this as the sub-session primitive: Claude/Fable can create Codex workers, Codex can create Claude workers, and either can report back to this parent session. mode 'ask' (default) runs read-only on the selected repo checkout; mode 'code' can edit files / open PRs (never merges). A code worker created from a session joins that session's workspace and SHARES its worktree and branch (same workspace = same worktree); `branch` is only used when there is nothing to share — a standalone worker, or a worker targeting a different repo than the parent. Repo defaults to the parent session's repo (tella-fusion when standalone); pass repo to override, for example repo: 'backstage'. Pass model 'gpt-5.5'/'codex' for a Codex worker or a Claude model id for a Claude worker. For workers that only need filesystem/code access, pass mcpServers: [] to avoid unrelated MCP startup cost/failures. When called from a session, the worker defaults to the same workspace and is instructed to report back here; set standalone true or reportBack false to opt out.",
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
            .describe("Fallback branch for code mode (required); only used when the worker can't share the parent workspace's worktree (standalone or different repo). Ignored for ask."),
          model: z.string().optional().describe("Optional model id (e.g. 'claude-opus-4-8')."),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe("Optional MCP server allowlist for the opening run. Use [] for no MCP servers."),
          parentSessionId: z
            .string()
            .optional()
            .describe("Session id this worker should report back to. Defaults to the current session when available."),
          reportBack: z
            .boolean()
            .optional()
            .describe("Whether to append report-back instructions to the worker prompt. Defaults true when a parent session id is available."),
          standalone: z
            .boolean()
            .optional()
            .describe("Create an unrelated standalone session instead of a child of the current session."),
          sandbox: z
            .union([z.boolean(), z.enum(["docker", "daytona", "e2b"])])
            .optional()
            .describe("Run the session in an isolated sandbox: true = the server's default provider, or an explicit provider id (must be configured server-side, else the create fails with a clear error). Omit for a host run."),
        },
        async (args: {
          prompt: string;
          repo?: string;
          mode?: "ask" | "code";
          branch?: string;
          model?: string;
          mcpServers?: string[];
          parentSessionId?: string;
          reportBack?: boolean;
          standalone?: boolean;
          sandbox?: boolean | "docker" | "daytona" | "e2b";
        }) => {
          if (!args.prompt?.trim()) return text("Need a prompt to start a session.");
          if (args.mode === "code" && !args.branch?.trim()) {
            return text("Code mode needs a `branch` for the worktree.");
          }
          const parentSessionId = args.standalone
            ? undefined
            : args.parentSessionId || ctx.currentSessionId;
          const shouldReportBack = args.reportBack ?? Boolean(parentSessionId);
          const prompt = parentSessionId
            ? buildChildSessionPrompt({
                prompt: args.prompt,
                parentSessionId,
                reportBack: shouldReportBack,
              })
            : args.prompt;
          const { id } = await getSessionControl().createSession({
            prompt,
            repo: args.repo,
            mode: args.mode,
            branch: args.branch,
            model: args.model,
            mcpServers: args.mcpServers,
            parentSessionId,
            reportBack: shouldReportBack,
            user: ctx.createdBy,
            sandbox: args.sandbox,
          });
          return text(
            [
              `Started session \`${id}\` (${args.mode === "code" ? `code on ${args.branch}` : "ask"}). It'll appear in list_sessions as it boots.`,
              parentSessionId && shouldReportBack
                ? `It is linked to \`${parentSessionId}\` and has instructions to report back there.`
                : "",
            ].filter(Boolean).join(" ")
          );
        }
      ),
      tool(
        "migrate_session_engine",
        "Migrate an existing session onto the OpenCode engine by flipping its model to an opencode/* id (e.g. opencode/anthropic/claude-sonnet-5). Does NOT start a run: the session's NEXT prompt builds a transcript handoff from its claude/codex history and continues on a fresh OpenCode session — file, workspace, branch, title and UI history all stay. Refuses automation-owned sessions (the opencode engine hard-gates automations off) and sessions that are mid-run.",
        {
          sessionId: z.string().describe("The backstage session id to migrate, e.g. 'bks-…'."),
          model: z
            .string()
            .describe("Target opencode model id: opencode/<provider>/<model>, e.g. opencode/anthropic/claude-sonnet-5."),
        },
        async (args: { sessionId: string; model: string }) => {
          // Belt-and-braces busy check through the live registry (the helper
          // re-checks via the run journal): a running/queued session's model
          // must not be flipped under its in-flight turn.
          try {
            const s = getSessionControl().getSession(args.sessionId);
            if (s && (s.state === "running" || s.state === "waiting_question")) {
              return text(
                `\`${args.sessionId}\` is ${s.state} — let the run finish (or cancel it) before migrating.`
              );
            }
          } catch {}
          const res = migrateSessionEngine(args.sessionId, args.model, ctx.createdBy);
          if (!res.ok) return text(res.error);
          return text(
            `Migrated \`${res.sessionId}\` to ${res.to}` +
              (res.from ? ` (was ${res.from})` : "") +
              ". The next prompt hands its history to the OpenCode engine and continues there."
          );
        }
      ),
      // ---------------------------------------------------------------------
      // Tasks — fire-and-forget child sessions (spawn / poll / cancel)
      // ---------------------------------------------------------------------
      tool(
        "spawn_task",
        "Delegate a self-contained task to a child session and return IMMEDIATELY with {taskId, url} — the lightweight alternative to create_session + send_to_session choreography when you just want work done and a handle to poll. The child is created through the same code path as create_session (it shares this session's worktree in code mode when repos match, inherits your user, is linked as a child, and is told to report back here); poll it with task_status and stop it with cancel_task. Mode defaults to 'code' (pass a branch unless the child can share this session's code worktree); use 'ask' for read-only investigation. Loop guard: spawned children may delegate one further level, then spawn_task refuses (depth ≥ 2). Not available from automation sessions.",
        {
          prompt: z.string().describe("Self-contained task prompt: scope, relevant files, constraints, acceptance criteria, and what to report."),
          repo: z.string().optional().describe("Registered repo id, e.g. 'tella-fusion' or 'backstage'. Defaults to this session's repo."),
          branch: z.string().optional().describe("Branch for code mode when the child can't share this session's worktree (standalone or different repo)."),
          model: z.string().optional().describe("Optional model id (e.g. 'gpt-5.5' for a Codex worker, or a Claude model id)."),
          mode: z.enum(["ask", "code"]).optional().describe("'code' (default) can edit files / open PRs; 'ask' is read-only."),
          sandbox: z.union([z.boolean(), z.enum(["docker", "daytona", "e2b"])]).optional().describe("Run the child in an isolated sandbox: true = the server's default provider, or an explicit configured provider id."),
        },
        async (args: SpawnTaskArgs) => {
          const res = await spawnTaskImpl(args, ctx);
          if (!res.ok) return text(res.error);
          return text(
            `Spawned task \`${res.taskId}\` — ${res.url}\nIt runs in the background; poll with task_status(taskId), answer questions with answer_session_question, stop with cancel_task.`
          );
        }
      ),
      tool(
        "task_status",
        "Status of a spawned task (or any session id): running / waiting (blocked on a question) / done / error, plus the recent transcript tail, a diff stat when it changed code, and its PR when one exists.",
        {
          taskId: z.string().describe("The task/session id returned by spawn_task."),
          transcript_lines: z.number().optional().describe("Trailing transcript entries to include (default 12)."),
        },
        async (args: { taskId: string; transcript_lines?: number }) =>
          text(await taskStatusImpl(args))
      ),
      tool(
        "cancel_task",
        "Cancel a spawned task's in-flight run (drops queued messages too). Same as cancel_session — only runs this server owns.",
        { taskId: z.string().describe("The task/session id returned by spawn_task.") },
        async (args: { taskId: string }) => text(cancelTaskImpl(args))
      )
    );
  }

  return createSdkMcpServer({
    name: "michael-sessions",
    version: "1.0.0",
    tools,
  });
}
