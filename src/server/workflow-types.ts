/**
 * Dynamic workflows — shared contracts.
 *
 * A workflow is a model-authored JS script (Claude Code Workflow-tool style:
 * `export const meta = {...}` + async body using agent()/parallel()/pipeline()/
 * phase()/log(), plus direct MCP tool calls) that fans out agent runs
 * deterministically. Tool calls are code mode at the tool layer rather than
 * the agent layer: one costs a round trip, not a model turn. The
 * script executes in a contained Bun Worker (src/server/workflow-worker.ts —
 * env-scrubbed and de-fanged, but exposure gating is the real trust boundary);
 * `agent()` calls bridge to the parent process, which executes them as plain
 * opencode runs (kind "workflow") via runAgent and returns the result into the
 * script. Heavier, steerable work (code mode + PR) stays on spawn_task — a
 * workflow agent is a focused, mostly read/analyze/report worker.
 *
 * Consumers:
 *  - workflow-runner.ts  — orchestration (worker lifecycle, semaphore, journal)
 *  - workflow-store.ts   — persistence (~/.opensession-workflows) + live registry
 *                          + workflow_update broadcasts
 *  - workflow-execute.ts — the real WorkflowExecutor on runAgent
 *  - workflow-mcp.ts     — the script's MCP host (transport + policy)
 *  - agents/slack/workflow-tools.ts — the opensession-workflows in-process MCP
 *  - routes/workflows.ts — HTTP reads for the UI
 *  - frontend WorkflowPanel.tsx — renders WorkflowRunSnapshot
 */

// ── Limits (single source of truth) ──────────────────────────────────────────

export const WORKFLOW_LIMITS = {
	/** Concurrent agent runs per workflow. */
	maxConcurrentAgents: 8,
	/** Concurrent WRITE agents (own pool): each one cuts a git worktree — heavy
	 *  on disk and on the repo's git lock, so it's kept well below the read pool. */
	maxConcurrentWriteAgents: 4,
	/** Lifetime agent() calls per workflow run. */
	maxAgents: 200,
	/** Lifetime write-agent calls per workflow run (worktrees are expensive). */
	maxWriteAgents: 40,
	/** Per-agent wall clock before the run is failed. */
	agentTimeoutMs: 15 * 60_000,
	/** Whole-workflow wall clock before the worker is terminated. */
	workflowTimeoutMs: 60 * 60_000,
	/** Schema-validation attempts per agent() call (1 initial + retries). */
	schemaAttempts: 3,
	/** Cap on stored/returned agent result text. */
	maxResultChars: 100_000,
	/** Cap on prompt/result previews inside snapshots (UI payloads). */
	previewChars: 600,
	/** Cap on the workflow script source. */
	maxScriptChars: 256_000,
	/** Cap on log lines kept in a snapshot. */
	maxLogLines: 200,
	// ── mcp.* (direct tool calls from the script) ──
	/** Concurrent MCP calls per workflow. Higher than the agent pool — these
	 *  are HTTP/stdio round trips, not model turns — but still bounded so a
	 *  fan-out can't hammer a third-party API. */
	maxConcurrentMcp: 16,
	/** Lifetime mcp.* calls per workflow run. */
	maxMcpCalls: 2_000,
	/** Per-call wall clock. */
	mcpCallTimeoutMs: 60_000,
	/** Handshake budget for the first call to a server (stdio servers boot a
	 *  process; HTTP ones may negotiate transports). */
	mcpConnectTimeoutMs: 30_000,
	/** Cap on one tool result (journaled AND structured-cloned to the worker). */
	maxMcpResultChars: 250_000,
	/** MCP calls kept on the snapshot (newest last) for the UI/status tail. */
	maxMcpSnapshotCalls: 50,
} as const;

// ── Script surface ───────────────────────────────────────────────────────────

/** `export const meta = {...}` — must be a pure object literal. */
export interface WorkflowMeta {
	name: string;
	description?: string;
	phases?: Array<{ title: string; detail?: string }>;
}

/** Options bag on an `agent(prompt, opts)` call inside a script. */
export interface WorkflowAgentOpts {
	/** Display label (defaults to a prompt prefix). */
	label?: string;
	/** Progress group; defaults to the phase() active at call time. */
	phase?: string;
	/** JSON Schema; when set the agent must return matching JSON and the
	 *  resolved value is the parsed object instead of text. */
	schema?: unknown;
	/** Model id (native or opencode form); defaults to the workflow default. */
	model?: string;
	/** Run this agent in code mode inside its OWN isolated git worktree
	 *  (branched off the session's branch) so it may edit files with zero
	 *  collisions against sibling agents. Its work is auto-committed on its own
	 *  branch; `merge()` lands selected branches back on the session's branch. */
	write?: boolean;
}

// ── Parent ⇄ executor contract ───────────────────────────────────────────────

export interface WorkflowAgentRequest {
	prompt: string;
	opts: WorkflowAgentOpts;
	/** Sequential call index within the run (journal key half). */
	seq: number;
}

export interface WorkflowExecCtx {
	runId: string;
	sessionId: string;
	user?: string;
	/** Working directory for the agent run (the session's worktree). */
	cwd: string;
	/** The session's repo id (worktree.ts REPOS key) — write agents cut their
	 *  isolated worktrees there, merge() lands them back. */
	repo?: string;
	/** The session's branch — the base a write agent's branch is cut from and
	 *  the branch merge() merges into. */
	baseBranch?: string;
	/** Default model when the call doesn't override. */
	defaultModel?: string;
	/** Flipped on cancel/timeouts — executors stop consuming and cancel the
	 *  underlying engine run. */
	signal: AbortSignal;
	/** Reported as soon as the engine session exists, so the snapshot carries
	 *  the drill-in pointer WHILE the agent runs (the journal entry only lands
	 *  when it finishes). */
	onEngineSession?: (engineSessionId: string) => void;
}

export interface WorkflowAgentOutcome {
	ok: boolean;
	/** Raw final text (capped at maxResultChars). */
	text?: string;
	/** Parsed schema-validated value when the call carried a schema. */
	structured?: unknown;
	error?: string;
	model?: string;
	tokens?: { input: number; output: number };
	/** The opencode session this agent ran in — the transcript drill-in pointer. */
	engineSessionId?: string;
	/** Where it ran (the session's worktree, or a write agent's own one). */
	cwd?: string;
	// ── write agents ──
	/** The agent's own branch (write agents only). */
	branch?: string;
	worktreeDir?: string;
	/** Did the agent actually change anything? (false → worktree removed.) */
	changed?: boolean;
	/** Paths touched vs. the base commit. */
	files?: string[];
	insertions?: number;
	deletions?: number;
	/** The auto-commit's sha. */
	commit?: string;
}

/** Outcome of a merge() call: every branch lands in exactly one bucket. A
 *  conflicted branch never sinks the batch — the merge is aborted, the
 *  conflicting files are reported, and the next branch is tried. `error` is set
 *  when the batch was refused wholesale (dirty session worktree, live shared
 *  checkout) — nothing was merged in that case. */
export interface WorkflowMergeResult {
	merged: Array<{ branch: string; seq: number }>;
	conflicts: Array<{ branch: string; seq: number; files: string[] }>;
	skipped: Array<{ branch: string; seq: number; reason: string }>;
	error?: string;
}

/** Executes one agent() call. The real implementation drives runAgent; tests
 *  inject fakes. */
export interface WorkflowExecutor {
	execute(
		req: WorkflowAgentRequest,
		ctx: WorkflowExecCtx,
	): Promise<WorkflowAgentOutcome>;
	/** Land write agents' branches on the session's branch. Optional so test
	 *  fakes don't have to implement it (the runner reports a clear error when
	 *  a script calls merge() against an executor that can't). */
	merge?(
		ctx: WorkflowExecCtx,
		items: Array<{ seq: number; branch: string }>,
	): Promise<WorkflowMergeResult>;
}

// ── Persistence / snapshots (UI payloads) ────────────────────────────────────

export type WorkflowAgentStatus =
	| "pending"
	| "running"
	| "done"
	| "error"
	| "cancelled";

export interface WorkflowAgentSnapshot {
	seq: number;
	label: string;
	phase?: string;
	model?: string;
	status: WorkflowAgentStatus;
	/** Truncated to previewChars for snapshot payloads. */
	promptPreview: string;
	resultPreview?: string;
	error?: string;
	startedAt?: string;
	endedAt?: string;
	tokens?: { input: number; output: number };
	/** True when the result came from the journal (resume replay). */
	cached?: boolean;
	/** True when the call carried a schema. */
	structured?: boolean;
	/** The agent's opencode session — the UI's transcript drill-in pointer.
	 *  Set as soon as the engine session exists (not only when the agent ends). */
	engineSessionId?: string;
	// ── write agents ──
	write?: boolean;
	branch?: string;
	changed?: boolean;
	filesChanged?: number;
	insertions?: number;
	deletions?: number;
	/** Set by a merge() call that included this agent's branch. */
	merged?: "merged" | "conflict";
}

export type WorkflowRunStatus =
	| "running"
	| "done"
	| "error"
	| "cancelled"
	/** Marked on boot for runs that were live when the process died. */
	| "interrupted";

export interface WorkflowRunSnapshot {
	runId: string;
	sessionId: string;
	name: string;
	description?: string;
	status: WorkflowRunStatus;
	/** Phase titles in first-seen order (meta.phases pre-seed it). */
	phases: string[];
	currentPhase?: string;
	agents: WorkflowAgentSnapshot[];
	logs: Array<{ ts: string; message: string }>;
	/** Script return value (JSON-serializable, capped). Set when done. */
	result?: unknown;
	error?: string;
	startedAt: string;
	endedAt?: string;
	totals: {
		agents: number;
		tokensIn: number;
		tokensOut: number;
		/** mcp.* calls made by the script (absent on pre-mcp runs). */
		mcpCalls?: number;
		mcpErrors?: number;
	};
	/** Tail of recent mcp.* calls (capped at maxMcpSnapshotCalls). */
	mcpCalls?: WorkflowMcpCallSnapshot[];
	user?: string;
	cwd: string;
}

/** One completed agent() call in journal.jsonl — the resume-replay unit and
 *  the UI's drill-in detail (full prompt/result, not previews). */
export interface WorkflowJournalEntry {
	seq: number;
	/** Hash of (prompt + canonicalized opts); replay requires seq+hash match. */
	hash: string;
	/** Absent on entries written before mcp.* existed — those are all agents. */
	kind?: "agent";
	prompt: string;
	opts: WorkflowAgentOpts;
	outcome: WorkflowAgentOutcome;
	startedAt: string;
	endedAt: string;
}

/** One completed mcp.* call. Journaled for the same reason agent calls are:
 *  a resumed run must REPLAY it rather than re-fire it — that's what makes
 *  resuming a script that created a Linear issue safe. */
export interface WorkflowMcpJournalEntry {
	kind: "mcp";
	seq: number;
	/** Hash of (server, tool, canonicalized args). */
	hash: string;
	server: string;
	tool: string;
	args: unknown;
	ok: boolean;
	/** The normalized value the script received (capped). */
	value?: unknown;
	error?: string;
	startedAt: string;
	endedAt: string;
}

export type WorkflowJournalRecord =
	| WorkflowJournalEntry
	| WorkflowMcpJournalEntry;

export function isMcpJournalEntry(
	entry: WorkflowJournalRecord,
): entry is WorkflowMcpJournalEntry {
	return entry.kind === "mcp";
}

/** A recent mcp.* call, surfaced on the snapshot (capped at
 *  maxMcpSnapshotCalls) so the UI and workflow_status can show what the script
 *  is actually touching without journal reads. */
export interface WorkflowMcpCallSnapshot {
	seq: number;
	server: string;
	tool: string;
	ok: boolean;
	/** Wall-clock duration in ms. */
	ms: number;
	error?: string;
	/** True when answered from the journal on a resume. */
	cached?: boolean;
}

// ── Worker ⇄ parent message protocol ─────────────────────────────────────────

export type WorkerToParent =
	| {
			type: "agent_call";
			callId: number;
			seq: number;
			prompt: string;
			opts: WorkflowAgentOpts;
	  }
	| {
			type: "merge_call";
			callId: number;
			items: Array<{ seq: number; branch: string }>;
	  }
	| {
			type: "mcp_call";
			callId: number;
			seq: number;
			server: string;
			tool: string;
			args: unknown;
	  }
	/** mcp.servers() / mcp.tools(server) — discovery, never journaled. */
	| { type: "mcp_meta"; callId: number; server?: string }
	| { type: "phase"; title: string }
	| { type: "log"; message: string }
	| { type: "done"; result: unknown }
	| { type: "error"; message: string };

export type ParentToWorker =
	| { type: "start"; body: string; args: unknown }
	| {
			type: "agent_result";
			callId: number;
			ok: boolean;
			/** The resolved value for the script: for a write agent the result
			 *  object (branch + diffstat + text), else structured ?? text; null on
			 *  error. */
			value: unknown;
			error?: string;
			tokensOut?: number;
	  }
	| { type: "merge_result"; callId: number; result: WorkflowMergeResult }
	/** Answers both mcp_call and mcp_meta. Unlike agent_result, `ok:false`
	 *  REJECTS the script's promise (a tool call is an exception, not a fuzzy
	 *  outcome) — parallel() still degrades a throw to null. */
	| {
			type: "mcp_result";
			callId: number;
			ok: boolean;
			value: unknown;
			error?: string;
	  };
