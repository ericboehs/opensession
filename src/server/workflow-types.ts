/**
 * Dynamic workflows — shared contracts.
 *
 * A workflow is a model-authored JS script (Claude Code Workflow-tool style:
 * `export const meta = {...}` + async body using agent()/parallel()/pipeline()/
 * phase()/log()) that fans out lightweight agent runs deterministically. The
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
 *  - agents/slack/workflow-tools.ts — the opensession-workflows in-process MCP
 *  - routes/workflows.ts — HTTP reads for the UI
 *  - frontend WorkflowPanel.tsx — renders WorkflowRunSnapshot
 */

// ── Limits (single source of truth) ──────────────────────────────────────────

export const WORKFLOW_LIMITS = {
	/** Concurrent agent runs per workflow. */
	maxConcurrentAgents: 8,
	/** Lifetime agent() calls per workflow run. */
	maxAgents: 200,
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
	/** Default model when the call doesn't override. */
	defaultModel?: string;
	/** Flipped on cancel/timeouts — executors stop consuming and cancel the
	 *  underlying engine run. */
	signal: AbortSignal;
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
}

/** Executes one agent() call. The real implementation drives runAgent; tests
 *  inject fakes. */
export interface WorkflowExecutor {
	execute(
		req: WorkflowAgentRequest,
		ctx: WorkflowExecCtx,
	): Promise<WorkflowAgentOutcome>;
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
	totals: { agents: number; tokensIn: number; tokensOut: number };
	user?: string;
	cwd: string;
}

/** One completed agent() call in journal.jsonl — the resume-replay unit and
 *  the UI's drill-in detail (full prompt/result, not previews). */
export interface WorkflowJournalEntry {
	seq: number;
	/** Hash of (prompt + canonicalized opts); replay requires seq+hash match. */
	hash: string;
	prompt: string;
	opts: WorkflowAgentOpts;
	outcome: WorkflowAgentOutcome;
	startedAt: string;
	endedAt: string;
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
			/** The resolved value for the script: structured ?? text; null on error. */
			value: unknown;
			error?: string;
			tokensOut?: number;
	  };
