/**
 * Workflow agent executor — the real WorkflowExecutor behind workflow-runner.
 *
 * Each `agent()` call inside a workflow script becomes one lightweight
 * opencode run (journal kind "workflow", mode "ask", cwd = the session's
 * worktree) driven to completion here. Deliberately minimal RunAgentOpts: no
 * mcpServers, no inProcessMcp, no deniedTools — ask mode already withholds
 * write tools, and kind "workflow" is interactive-trusted (the
 * opensession-workflows MCP that launches these is interactive-only).
 *
 * Schema mode (WorkflowAgentOpts.schema): the agent is told to reply with a
 * fenced ```json block; we extract the LAST fenced block (whole-reply parse
 * fallback), validate against a minimal JSON Schema subset, and on failure
 * retry by resuming the SAME engine session with a correction prompt — up to
 * WORKFLOW_LIMITS.schemaAttempts total attempts.
 */

import { runAgent, type RunAgentOpts, type StreamEvent } from "./agent-runner";
import { cancelOpencodeRun } from "./opencode-runner";
import { getDefaultModel } from "./models";
import {
	WORKFLOW_LIMITS,
	type WorkflowAgentOutcome,
	type WorkflowAgentRequest,
	type WorkflowExecCtx,
	type WorkflowExecutor,
} from "./workflow-types";

// ── runAgent seam (tests inject a fake; never spin real engine runs) ─────────

type RunAgentFn = (opts: RunAgentOpts) => AsyncGenerator<StreamEvent>;

let runAgentImpl: RunAgentFn = runAgent;

/** Test seam: swap the runAgent implementation (null restores the real one). */
export function _setRunAgentForTests(fn: RunAgentFn | null): void {
	runAgentImpl = fn ?? runAgent;
}

// ── runAgentCollect ──────────────────────────────────────────────────────────

export interface RunAgentCollectResult {
	text: string;
	model?: string;
	tokens?: { input: number; output: number };
	engineSessionId?: string;
	error?: string;
}

/**
 * Drive runAgent to completion, accumulating the streamed text. On abort we
 * stop consuming, best-effort cancel the underlying engine run, and return
 * error "cancelled" (the race means a hung engine run can't wedge a cancel).
 */
export async function runAgentCollect(
	opts: RunAgentOpts,
	signal?: AbortSignal,
): Promise<RunAgentCollectResult> {
	let text = "";
	let model: string | undefined;
	let tokens: { input: number; output: number } | undefined;
	let engineSessionId: string | undefined;
	let error: string | undefined;
	let skipRunnerNotice = false;

	// Already cancelled: never start the engine run at all.
	if (signal?.aborted) return { text, error: "cancelled" };

	const it = runAgentImpl(opts)[Symbol.asyncIterator]();
	const aborted: Promise<"aborted"> | null = signal
		? new Promise((resolve) => {
				if (signal.aborted) resolve("aborted");
				else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
			})
		: null;

	try {
		for (;;) {
			const next = aborted ? await Promise.race([it.next(), aborted]) : await it.next();
			if (next === "aborted") {
				if (engineSessionId) {
					try {
						cancelOpencodeRun(engineSessionId);
					} catch {}
				}
				void it.return?.(undefined)?.catch?.(() => {});
				return { text, model, tokens, engineSessionId, error: "cancelled" };
			}
			if (next.done) break;
			const event = next.value;
			if (event.type === "init") {
				engineSessionId = event.sessionId || engineSessionId;
				model = event.model || model;
			} else if (event.type === "model_switch") {
				// Usage-limit fallback: agent-runner re-runs the FULL prompt on the
				// fallback model (model_switch event + a synthetic "[runner] …" text
				// chunk, then a complete fresh reply). The collected text IS the
				// agent() return value, so drop the pre-switch partial reply and
				// swallow the notice chunk that follows.
				text = "";
				skipRunnerNotice = true;
				model = event.toModel || model;
			} else if (event.type === "text_chunk" && event.text) {
				if (skipRunnerNotice) {
					skipRunnerNotice = false;
					if (event.text.trimStart().startsWith("[runner] ")) continue;
				}
				text += event.text;
			} else if (event.type === "done") {
				model = event.model || model;
				if (event.usage) {
					tokens = { input: event.usage.inputTokens, output: event.usage.outputTokens };
				}
			} else if (event.type === "error") {
				error = event.content || "agent run failed";
			}
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { text, model, tokens, engineSessionId, error };
}

// ── Fenced-JSON extraction ───────────────────────────────────────────────────

/**
 * The LAST ```json fenced block in the reply (falling back to the last
 * untagged ``` block); null when there's no fence — callers then try the
 * whole reply as JSON.
 */
export function extractLastFencedJson(text: string): string | null {
	const tagged = [...text.matchAll(/```json[^\S\n]*\n?([\s\S]*?)```/gi)];
	if (tagged.length) return tagged[tagged.length - 1][1].trim();
	const bare = [...text.matchAll(/```[^\S\n]*\n?([\s\S]*?)```/g)];
	if (bare.length) return bare[bare.length - 1][1].trim();
	return null;
}

// ── Minimal JSON Schema subset validator ─────────────────────────────────────
// (anthropic-bridge.ts's general jsonSchemaToZod isn't exported — only the
// tool-shape helper — so this stays a tiny pure function here.)

function jsonTypeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function joinPath(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

/**
 * Validate `value` against a minimal JSON Schema subset: type (object/array/
 * string/number/integer/boolean/null, or an array of those — any match
 * passes), properties, required, items (single schema or tuple form —
 * index-wise, extra items pass), enum, const, anyOf (any branch passes),
 * additionalProperties:false. Property checks use own-property semantics
 * (Object.hasOwn) so keys like "constructor"/"toString" behave like any
 * other. Returns descriptive error paths ("files[2]: expected string, got
 * number"); empty array = valid.
 */
export function validateJsonSchema(value: unknown, schema: unknown): string[] {
	const errors: string[] = [];
	walkSchema(value, schema, "", errors);
	return errors;
}

function walkSchema(value: unknown, schema: unknown, path: string, errors: string[]): void {
	const at = path || "(root)";
	if (Array.isArray(schema)) {
		// A bare array is not a schema node (tuple-form arrays are handled at
		// the `items` site below) — flag it instead of silently passing.
		errors.push(`${at}: invalid schema node (array where a schema object was expected)`);
		return;
	}
	if (!schema || typeof schema !== "object") return;
	const s = schema as Record<string, unknown>;

	if ("const" in s) {
		if (JSON.stringify(value) !== JSON.stringify(s.const)) {
			errors.push(`${at}: expected const ${JSON.stringify(s.const)}`);
			return;
		}
	}
	if (Array.isArray(s.enum)) {
		const match = s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value));
		if (!match) {
			errors.push(`${at}: expected one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}`);
			return;
		}
	}
	if (Array.isArray(s.anyOf)) {
		const anyPass = s.anyOf.some((branch) => {
			const branchErrors: string[] = [];
			walkSchema(value, branch, path, branchErrors);
			return branchErrors.length === 0;
		});
		if (!anyPass) {
			errors.push(`${at}: matched no anyOf branch`);
			return;
		}
	}

	const types =
		typeof s.type === "string"
			? [s.type]
			: Array.isArray(s.type)
				? s.type.filter((t): t is string => typeof t === "string")
				: [];
	if (types.length) {
		const actual = jsonTypeOf(value);
		const ok = types.some((type) =>
			type === "integer" ? actual === "number" && Number.isInteger(value) : actual === type,
		);
		if (!ok) {
			errors.push(`${at}: expected ${types.join(" | ")}, got ${actual}`);
			return;
		}
	}

	if (jsonTypeOf(value) === "object") {
		const obj = value as Record<string, unknown>;
		const props =
			s.properties && typeof s.properties === "object"
				? (s.properties as Record<string, unknown>)
				: undefined;
		if (Array.isArray(s.required)) {
			for (const key of s.required) {
				if (typeof key === "string" && !Object.hasOwn(obj, key)) {
					errors.push(`${joinPath(path, key)}: missing required property`);
				}
			}
		}
		if (props) {
			for (const [key, sub] of Object.entries(props)) {
				if (Object.hasOwn(obj, key)) walkSchema(obj[key], sub, joinPath(path, key), errors);
			}
		}
		if (s.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!props || !Object.hasOwn(props, key)) {
					errors.push(`${joinPath(path, key)}: unexpected property`);
				}
			}
		}
	}

	if (Array.isArray(value) && s.items) {
		if (Array.isArray(s.items)) {
			// Tuple form: validate index-wise; extra items beyond the tuple pass.
			const tuple = s.items;
			value.forEach((item, i) => {
				if (i < tuple.length) walkSchema(item, tuple[i], `${path}[${i}]`, errors);
			});
		} else {
			value.forEach((item, i) => walkSchema(item, s.items, `${path}[${i}]`, errors));
		}
	}
}

// ── The executor ─────────────────────────────────────────────────────────────

/** Terse preamble so the worker's final message is machine-consumable. */
const WORKER_PREAMBLE =
	"You are a focused worker agent inside a scripted workflow. Your final " +
	"message IS the return value a script consumes — output exactly the " +
	"requested data, with no greeting, preamble, or sign-off. Be " +
	"self-contained: don't reference other agents or ask questions.";

function capResult(text: string): string {
	return text.length > WORKFLOW_LIMITS.maxResultChars
		? text.slice(0, WORKFLOW_LIMITS.maxResultChars)
		: text;
}

function addTokens(
	total: { input: number; output: number } | undefined,
	add: { input: number; output: number } | undefined,
): { input: number; output: number } | undefined {
	if (!add) return total;
	if (!total) return { ...add };
	return { input: total.input + add.input, output: total.output + add.output };
}

export const workflowExecutor: WorkflowExecutor = {
	async execute(req: WorkflowAgentRequest, ctx: WorkflowExecCtx): Promise<WorkflowAgentOutcome> {
		const model = req.opts.model || ctx.defaultModel || getDefaultModel();

		// Per-agent timeout + the workflow's cancel signal fold into one signal.
		const inner = new AbortController();
		let timedOut = false;
		const onCancel = () => inner.abort();
		if (ctx.signal.aborted) inner.abort();
		else ctx.signal.addEventListener("abort", onCancel, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			inner.abort();
		}, WORKFLOW_LIMITS.agentTimeoutMs);

		try {
			const baseOpts: RunAgentOpts = {
				prompt: "",
				cwd: ctx.cwd,
				mode: "ask",
				model,
				user: ctx.user,
				journal: { kind: "workflow" },
			};
			let prompt = `${WORKER_PREAMBLE}\n\n${req.prompt}`;

			const cancelError = () =>
				timedOut
					? `agent timed out after ${Math.round(WORKFLOW_LIMITS.agentTimeoutMs / 60_000)}m`
					: "workflow cancelled";

			if (req.opts.schema === undefined) {
				const res = await runAgentCollect({ ...baseOpts, prompt }, inner.signal);
				if (res.error) {
					return {
						ok: false,
						error: res.error === "cancelled" ? cancelError() : res.error,
						model: res.model || model,
						tokens: res.tokens,
					};
				}
				return { ok: true, text: capResult(res.text), model: res.model || model, tokens: res.tokens };
			}

			// Schema mode: demand a fenced json block, validate, retry by
			// resuming the same engine session with the validation errors.
			prompt +=
				"\n\nReply with ONLY a fenced ```json block matching this JSON Schema:\n" +
				JSON.stringify(req.opts.schema);
			let engineSessionId: string | undefined;
			let tokens: { input: number; output: number } | undefined;
			let lastModel: string | undefined;
			let lastError = "";
			for (let attempt = 0; attempt < WORKFLOW_LIMITS.schemaAttempts; attempt++) {
				// The retry resumes the same engine session, but the resume target can
				// be silently lost (no engineSessionId on pre-init termination; the
				// runner falls back to a fresh session when the id misses) — so every
				// retry prompt is self-contained: it restates the full original task
				// prompt (which ends with the schema) alongside the validation errors.
				const attemptPrompt =
					attempt === 0
						? prompt
						: `Your reply failed JSON Schema validation:\n${lastError}\n\n` +
							"Reply again with ONLY a fenced ```json block matching the schema — no other " +
							"text. In case earlier context was lost, the original task follows.\n\n" +
							prompt;
				const res = await runAgentCollect(
					{ ...baseOpts, prompt: attemptPrompt, sessionId: engineSessionId },
					inner.signal,
				);
				engineSessionId = res.engineSessionId || engineSessionId;
				tokens = addTokens(tokens, res.tokens);
				lastModel = res.model || lastModel;
				if (res.error) {
					return {
						ok: false,
						error: res.error === "cancelled" ? cancelError() : res.error,
						model: lastModel || model,
						tokens,
					};
				}
				const raw = extractLastFencedJson(res.text) ?? res.text.trim();
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch (e) {
					lastError = `not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
					continue;
				}
				const schemaErrors = validateJsonSchema(parsed, req.opts.schema);
				if (!schemaErrors.length) {
					return {
						ok: true,
						text: capResult(res.text),
						structured: parsed,
						model: lastModel || model,
						tokens,
					};
				}
				lastError = schemaErrors.join("; ");
			}
			return {
				ok: false,
				error: `schema validation failed after ${WORKFLOW_LIMITS.schemaAttempts} attempts: ${lastError}`,
				model: lastModel || model,
				tokens,
			};
		} finally {
			clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onCancel);
		}
	},
};
