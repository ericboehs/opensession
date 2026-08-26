/**
 * Workflow Worker entry — the contained execution side of dynamic workflows.
 *
 * The parent (workflow-runner.ts) spawns this as a Bun Worker and posts
 * {type:"start", body, args}. The script body executes here as an
 * AsyncFunction whose named parameters ARE the script API (agent/parallel/
 * pipeline/merge/mcp/phase/log/args/budget) — top-level `return` works. The
 * `mcp` global is the tool half of code mode: mcp.<server>.<tool>(args) is a
 * round trip through the parent's MCP host, not a model turn. The worker is
 * containment, not a hard sandbox (see scrubDangerousGlobals): env and the
 * exfil/spawn globals are stripped before the body runs, and the real trust
 * boundary is exposure — only interactive sessions can start workflows.
 * Every agent() and mcp.* call bridges over postMessage to the parent, which
 * runs it and posts the matching agent_result / mcp_result back.
 *
 * Determinism: resume replay re-runs the script and answers repeated agent()
 * and mcp.* calls from the journal, so the script must be a pure function of
 * args + call results. Date.now(), argless `new Date()` and Math.random() are
 * poisoned (throw) to keep it that way; `new Date(ms)` still works.
 *
 * Keep this file dependency-free (type-only imports): it runs on a second
 * thread and must never drag server state along.
 */

import type {
	ParentToWorker,
	WorkerToParent,
	WorkflowAgentOpts,
} from "./workflow-types";

const workerGlobal = globalThis as unknown as {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage: (message: unknown) => void;
};

// Captured before the global scrub — post() must keep working after
// scrubDangerousGlobals() strips the script-facing surface.
const rawPostMessage = workerGlobal.postMessage.bind(globalThis);

function post(msg: WorkerToParent): void {
	rawPostMessage(msg);
}

// ── Bridge state ─────────────────────────────────────────────────────────────

const pendingCalls = new Map<number, (value: unknown) => void>();
/** mcp.* calls settle with reject-on-error, so they need both handlers. */
const pendingMcp = new Map<
	number,
	{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();
let callCounter = 0;
let mcpSeq = 0;
let currentPhase: string | undefined;
let budgetTotal: number | null = null;
let budgetSpent = 0;
let started = false;

// ── Script API (injected as AsyncFunction params) ────────────────────────────

/** Bridge one agent call to the parent. Resolves to the agent's final text
 *  (or schema-validated object), or null when the agent errored — never
 *  rejects; the script decides what to do with nulls. */
function agent(prompt: unknown, opts?: WorkflowAgentOpts): Promise<unknown> {
	const callId = callCounter++;
	// The bridge call id is also the agent invocation ordinal. The parent uses
	// it to restore repeated identical calls in invocation order on replay.
	const seq = callId;
	const callOpts: WorkflowAgentOpts = { ...(opts || {}) };
	if (callOpts.phase === undefined && currentPhase !== undefined) {
		callOpts.phase = currentPhase;
	}
	return new Promise((resolve) => {
		pendingCalls.set(callId, resolve);
		post({ type: "agent_call", callId, seq, prompt: String(prompt), opts: callOpts });
	});
}

/** Land write agents' branches on the session's branch, sequentially. Accepts
 *  a single write-agent result, an array of them, or bare {seq, branch} items;
 *  nulls and unchanged/branchless agents are dropped. Resolves to a
 *  WorkflowMergeResult ({ merged, conflicts, skipped, error }) — a conflicted
 *  branch never rejects; it's reported and the batch continues. */
function merge(input: unknown): Promise<unknown> {
	const list = Array.isArray(input) ? input : [input];
	const items: Array<{ seq: number; branch: string }> = [];
	for (const it of list) {
		if (!it || typeof it !== "object") continue;
		const o = it as { seq?: unknown; branch?: unknown };
		if (typeof o.branch === "string" && o.branch && typeof o.seq === "number") {
			items.push({ seq: o.seq, branch: o.branch });
		}
	}
	const callId = callCounter++;
	return new Promise((resolve) => {
		pendingCalls.set(callId, resolve);
		post({ type: "merge_call", callId, items });
	});
}

/** Barrier over thunks; a thrown thunk resolves to null, never rejects the
 *  batch. */
function parallel(thunks: Array<() => unknown>): Promise<unknown[]> {
	return Promise.all(
		(thunks || []).map((thunk) =>
			Promise.resolve()
				.then(thunk)
				.catch(() => null),
		),
	);
}

/** Per-item stage chain with NO barrier between stages: item B can be in
 *  stage 1 while item A is already in stage 2. Stage callbacks get
 *  (prev, originalItem, index). A throwing stage drops the item to null and
 *  skips its remaining stages. Resolves once every item finished its chain. */
function pipeline(
	items: unknown[],
	...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
): Promise<unknown[]> {
	return Promise.all(
		(items || []).map(async (item, index) => {
			let prev: unknown = item;
			for (const stage of stages) {
				try {
					prev = await stage(prev, item, index);
				} catch {
					return null;
				}
			}
			return prev;
		}),
	);
}

// ── mcp.* (direct tool calls) ────────────────────────────────────────────────

/** Bridge one MCP tool call. REJECTS on failure (unlike agent(), which
 *  resolves null): a tool call failing is an exception the script can try/catch,
 *  and parallel() already degrades a throw to null. */
function mcpCall(server: unknown, tool: unknown, callArgs?: unknown): Promise<unknown> {
	const callId = callCounter++;
	const seq = mcpSeq++;
	return new Promise((resolve, reject) => {
		pendingMcp.set(callId, { resolve, reject });
		post({
			type: "mcp_call",
			callId,
			seq,
			server: String(server),
			tool: String(tool),
			args: callArgs ?? {},
		});
	});
}

/** Discovery (servers/tools) — same bridge, never journaled. */
function mcpMeta(server?: string): Promise<unknown> {
	const callId = callCounter++;
	return new Promise((resolve, reject) => {
		pendingMcp.set(callId, { resolve, reject });
		post({ type: "mcp_meta", callId, ...(server ? { server } : {}) });
	});
}

/** Property names on `mcp` that are the API itself, not a server. */
const MCP_RESERVED = new Set(["call", "servers", "tools"]);

/**
 * `mcp.<server>.<tool>(args)` on top of mcpCall, plus the explicit
 * mcp.call/servers/tools forms. Both levels are lazy Proxies: no round trip is
 * made to build them, and unknown names fail at call time with the parent's
 * "no such server/tool" message rather than a bare `undefined is not a
 * function`.
 *
 * `then` MUST resolve to undefined on both levels — otherwise `await mcp.x`
 * (or a stray return of one) sees a thenable and hangs.
 */
function serverProxy(server: string): Record<string, (a?: unknown) => Promise<unknown>> {
	return new Proxy({} as Record<string, (a?: unknown) => Promise<unknown>>, {
		get(_target, prop) {
			if (typeof prop !== "string" || prop === "then") return undefined;
			return (toolArgs?: unknown) => mcpCall(server, prop, toolArgs);
		},
	});
}

const mcp: Record<string, unknown> = new Proxy(
	{
		/** Explicit form: mcp.call("grafana", "query_prometheus", {...}). */
		call: (server: unknown, tool: unknown, callArgs?: unknown) =>
			mcpCall(server, tool, callArgs),
		/** Server names this workflow may call (no connection made). */
		servers: () => mcpMeta(),
		/** Tool catalog for one server: [{ name, description, inputSchema }]. */
		tools: (server: unknown) => mcpMeta(String(server)),
	} as Record<string, unknown>,
	{
		get(target, prop) {
			if (typeof prop !== "string" || prop === "then") return undefined;
			if (MCP_RESERVED.has(prop)) return target[prop];
			return serverProxy(prop);
		},
	},
);

/** Set the current progress group for subsequent agent calls. */
function phase(title: unknown): void {
	currentPhase = String(title);
	post({ type: "phase", title: currentPhase });
}

/** Narrator line (store + UI). */
function log(message: unknown): void {
	post({ type: "log", message: String(message) });
}

/** Output-token budget: total from run options (null = unbounded). */
const budget = {
	get total(): number | null {
		return budgetTotal;
	},
	spent(): number {
		return budgetSpent;
	},
	remaining(): number {
		return budgetTotal === null
			? Infinity
			: Math.max(0, budgetTotal - budgetSpent);
	},
};

// ── Determinism poisoning ────────────────────────────────────────────────────

const POISON_MESSAGE =
	"Date.now()/Math.random() are unavailable in workflow scripts (they break resume replay); pass timestamps via args";

/**
 * Containment, not a hard boundary (review finding 2026-07-10): a Bun Worker
 * is a same-process thread, so without this the script body would see the
 * server's FULL process.env (every token Bun auto-loaded from .env — the very
 * env agent subprocesses are deliberately denied) plus Bun.spawn/file, fetch
 * and friends. Two layers: (1) scrub process.env (the Worker is spawned with a
 * minimal env too — belt and braces); (2) shadow the exfil/spawn globals as
 * AsyncFunction params bound to undefined (see DANGEROUS_GLOBALS / runBody) —
 * `delete globalThis.Bun` silently no-ops on non-configurable engine globals,
 * so lexical shadowing is the reliable containment. Known residual: dynamic
 * `import()` of node builtins (e.g. fs) can't be blocked in a Worker — with
 * env scrubbed that's file-system power comparable to the session's own bash,
 * and the tool is interactive-only, but this is NOT a hard sandbox against a
 * hostile script. The exposure gate (interactive sessions only) is the actual
 * trust boundary.
 */
const DANGEROUS_GLOBALS = [
	"Bun",
	"process",
	"fetch",
	"WebSocket",
	"XMLHttpRequest",
	"EventSource",
	"Worker",
	"require",
	"postMessage",
	"importScripts",
	"self",
	"globalThis",
];

function scrubEnv(): void {
	try {
		const env = (globalThis as any).process?.env;
		if (env) for (const key of Object.keys(env)) delete env[key];
	} catch {}
}

/** Called AFTER the bridge is set up and the body is compiled — bridge code
 *  never depends on these. `new Date(ms)`/`new Date(iso)` keep working. */
function poisonDeterminismHoles(): void {
	const OriginalDate = Date;
	class PoisonedDate extends OriginalDate {
		constructor(...dateArgs: unknown[]) {
			if (dateArgs.length === 0) throw new Error(POISON_MESSAGE);
			super(...(dateArgs as [number]));
		}
		static override now(): number {
			throw new Error(POISON_MESSAGE);
		}
	}
	(globalThis as any).Date = PoisonedDate;
	Math.random = () => {
		throw new Error(POISON_MESSAGE);
	};
}

// ── Execution ────────────────────────────────────────────────────────────────

/** Structured-clone safety for the top-level return value. */
function sanitizeResult(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		try {
			return String(value);
		} catch {
			return null;
		}
	}
}

async function runBody(
	body: string,
	args: unknown,
	total: number | null,
): Promise<void> {
	budgetTotal = total;
	try {
		// AsyncFunction with the API as named params (allows top-level return),
		// PLUS the dangerous globals shadowed as trailing params bound to
		// undefined — inside the body `Bun`, `process`, `fetch`, `globalThis`
		// etc. resolve to these locals, not the real globals.
		const AsyncFunction = async function () {}.constructor as new (
			...params: string[]
		) => (...values: unknown[]) => Promise<unknown>;
		const apiNames = ["agent", "parallel", "pipeline", "merge", "mcp", "phase", "log", "args", "budget"];
		const apiValues = [agent, parallel, pipeline, merge, mcp, phase, log, args, budget];
		const fn = new AsyncFunction(...apiNames, ...DANGEROUS_GLOBALS, body);
		scrubEnv();
		poisonDeterminismHoles();
		const result = await fn(
			...apiValues,
			...DANGEROUS_GLOBALS.map(() => undefined),
		);
		post({ type: "done", result: sanitizeResult(result) });
	} catch (e) {
		post({
			type: "error",
			message: e instanceof Error ? e.message : String(e),
		});
	}
}

workerGlobal.onmessage = (event: MessageEvent<unknown>) => {
	// The start message additionally carries budgetTotal (not part of the
	// ParentToWorker union — budget lives worker-side only).
	const msg = event.data as ParentToWorker & { budgetTotal?: number | null };
	if (msg.type === "start") {
		if (started) return;
		started = true;
		void runBody(msg.body, msg.args, msg.budgetTotal ?? null);
		return;
	}
	if (msg.type === "agent_result") {
		const resolve = pendingCalls.get(msg.callId);
		if (!resolve) return;
		pendingCalls.delete(msg.callId);
		if (typeof msg.tokensOut === "number") budgetSpent += msg.tokensOut;
		// null on error — the script filters, we never reject.
		resolve(msg.ok ? msg.value : null);
		return;
	}
	if (msg.type === "merge_result") {
		const resolve = pendingCalls.get(msg.callId);
		if (!resolve) return;
		pendingCalls.delete(msg.callId);
		resolve(msg.result);
		return;
	}
	if (msg.type === "mcp_result") {
		const handlers = pendingMcp.get(msg.callId);
		if (!handlers) return;
		pendingMcp.delete(msg.callId);
		// Reject with a real Error so the script gets a stack and can try/catch;
		// an uncaught one fails the run with the tool's own message.
		if (msg.ok) handlers.resolve(msg.value);
		else handlers.reject(new Error(msg.error || "MCP call failed"));
	}
};
