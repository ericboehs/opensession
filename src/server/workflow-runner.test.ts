import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	cancelWorkflow,
	parseWorkflowMeta,
	startWorkflow,
	type StartWorkflowOpts,
} from "./workflow-runner";
import { getWorkflowRun, readWorkflowJournal } from "./workflow-store";
import {
	WORKFLOW_LIMITS,
	type WorkflowAgentOutcome,
	type WorkflowAgentRequest,
	type WorkflowExecCtx,
	type WorkflowExecutor,
	type WorkflowRunSnapshot,
} from "./workflow-types";

const savedEnv = process.env.OPENSESSION_WORKFLOWS_DIR;
const dirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "wf-runner-test-"));
	dirs.push(dir);
	process.env.OPENSESSION_WORKFLOWS_DIR = dir;
});

afterAll(() => {
	if (savedEnv === undefined) delete process.env.OPENSESSION_WORKFLOWS_DIR;
	else process.env.OPENSESSION_WORKFLOWS_DIR = savedEnv;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

type ExecCall = { req: WorkflowAgentRequest; ctx: WorkflowExecCtx };

function fakeExecutor(
	fn: (
		req: WorkflowAgentRequest,
		ctx: WorkflowExecCtx,
	) => WorkflowAgentOutcome | Promise<WorkflowAgentOutcome>,
): WorkflowExecutor & { calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	return {
		calls,
		async execute(req, ctx) {
			calls.push({ req, ctx });
			return fn(req, ctx);
		},
	};
}

/** Echo executor: resolves every prompt to "R:<prompt>". */
function echoExecutor(tokens?: { input: number; output: number }) {
	return fakeExecutor((req) => ({ ok: true, text: `R:${req.prompt}`, ...(tokens ? { tokens } : {}) }));
}

async function waitUntil<T>(
	fn: () => T | undefined | false | null,
	timeoutMs = 8_000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function waitForFinished(runId: string): Promise<WorkflowRunSnapshot> {
	return waitUntil(() => {
		const s = getWorkflowRun(runId);
		return s && s.status !== "running" ? s : undefined;
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function start(overrides: Partial<StartWorkflowOpts> & { script: string; executor: WorkflowExecutor }) {
	return startWorkflow({
		sessionId: "bks-wf-test",
		cwd: "/tmp",
		...overrides,
	});
}

// ── parseWorkflowMeta ────────────────────────────────────────────────────────

describe("parseWorkflowMeta", () => {
	test("valid meta parses and the export is stripped from the body", () => {
		const script = `export const meta = { name: "audit", description: "check things" };\nreturn 1;`;
		const { meta, body } = parseWorkflowMeta(script);
		expect(meta.name).toBe("audit");
		expect(meta.description).toBe("check things");
		expect(body).not.toContain("export");
		expect(body).toContain("return 1;");
	});

	test("nested object literals (phases) survive the balanced-brace scan", () => {
		const script = [
			"export const meta = {",
			'\tname: "nested",',
			"\tphases: [",
			'\t\t{ title: "One", detail: "curly } in a string" },',
			'\t\t{ title: "Two" },',
			"\t],",
			"};",
			'return "body";',
		].join("\n");
		const { meta, body } = parseWorkflowMeta(script);
		expect(meta.phases?.map((p) => p.title)).toEqual(["One", "Two"]);
		expect(body.trim()).toBe('return "body";');
	});

	test("missing meta throws", () => {
		expect(() => parseWorkflowMeta("return 1;")).toThrow(/export const meta/);
	});

	test("non-literal meta throws", () => {
		expect(() =>
			parseWorkflowMeta("export const meta = buildMeta();\nreturn 1;"),
		).toThrow(/object literal/);
		expect(() =>
			parseWorkflowMeta("export const meta = { name: undefinedRef() };\nreturn 1;"),
		).toThrow(/object literal/);
		expect(() =>
			parseWorkflowMeta('export const meta = { name: "" };\nreturn 1;'),
		).toThrow(/meta\.name/);
	});
});

// ── Workflow execution ───────────────────────────────────────────────────────

describe("workflow runner", () => {
	test("happy path: phases, agents, logs, journal, result", async () => {
		const executor = echoExecutor({ input: 5, output: 7 });
		const { runId } = start({
			script: [
				'export const meta = { name: "happy", phases: [{ title: "Gather" }, { title: "Summarize" }] };',
				'phase("Gather");',
				'log("starting");',
				'const a = await agent("list things", { label: "lister" });',
				'phase("Summarize");',
				'const b = await agent("summarize: " + a);',
				"return { a, b };",
			].join("\n"),
			executor,
			user: "michiel",
			defaultModel: "claude-sonnet-5",
		});

		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual({
			a: "R:list things",
			b: "R:summarize: R:list things",
		});
		expect(s.name).toBe("happy");
		expect(s.phases).toEqual(["Gather", "Summarize"]);
		expect(s.currentPhase).toBe("Summarize");
		expect(s.logs.map((l) => l.message)).toEqual(["starting"]);
		expect(s.agents.length).toBe(2);
		expect(s.agents[0].label).toBe("lister");
		expect(s.agents[0].phase).toBe("Gather");
		expect(s.agents[0].status).toBe("done");
		expect(s.agents[1].phase).toBe("Summarize");
		expect(s.agents[1].status).toBe("done");
		expect(s.agents[1].label).toBe("summarize: R:list things");
		expect(s.totals).toEqual({ agents: 2, tokensIn: 10, tokensOut: 14 });
		expect(s.endedAt).toBeTruthy();

		// Executor got the run context.
		expect(executor.calls[0].ctx.sessionId).toBe("bks-wf-test");
		expect(executor.calls[0].ctx.cwd).toBe("/tmp");
		expect(executor.calls[0].ctx.user).toBe("michiel");
		expect(executor.calls[0].ctx.defaultModel).toBe("claude-sonnet-5");

		const journal = readWorkflowJournal(runId);
		expect(journal.length).toBe(2);
		expect(journal[0].prompt).toBe("list things");
		expect(journal[0].outcome.text).toBe("R:list things");
		expect(journal[0].hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("parallel: a thrown thunk resolves to null, others land", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "par" };',
				"return await parallel([",
				'\t() => agent("one"),',
				'\t() => { throw new Error("boom"); },',
				'\t() => agent("two"),',
				"]);",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual(["R:one", null, "R:two"]);
		expect(executor.calls.length).toBe(2);
	});

	test("pipeline: no barrier between stages", async () => {
		const seen: string[] = [];
		const holdS1B = deferred<WorkflowAgentOutcome>();
		const executor = fakeExecutor((req) => {
			seen.push(req.prompt);
			if (req.prompt === "s1:B") return holdS1B.promise;
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({
			script: [
				'export const meta = { name: "pipe" };',
				"return await pipeline(args.items,",
				'\t(item) => agent("s1:" + item),',
				'\t(prev, item) => agent("s2:" + item + ":" + prev),',
				");",
			].join("\n"),
			args: { items: ["A", "B"] },
			executor,
		});

		// Item A reaches stage 2 while item B's stage 1 is still in flight —
		// that's the no-barrier property.
		await waitUntil(() => seen.includes("s2:A:R:s1:A"));
		expect(seen).toContain("s1:B");
		expect(getWorkflowRun(runId)?.status).toBe("running");
		holdS1B.resolve({ ok: true, text: "R:s1:B" });

		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual(["R:s2:A:R:s1:A", "R:s2:B:R:s1:B"]);
	});

	test("pipeline: a throwing stage drops the item to null and skips its remaining stages", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "pipe-throw" };',
				'return await pipeline(["A", "B"],',
				'\t(item) => { if (item === "A") throw new Error("nope"); return agent("s1:" + item); },',
				'\t(prev) => agent("s2:" + prev),',
				");",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual([null, "R:s2:R:s1:B"]);
		// Item A never reached the executor at all.
		expect(executor.calls.map((c) => c.req.prompt).sort()).toEqual([
			"s1:B",
			"s2:R:s1:B",
		]);
	});

	test("schema pass-through: structured outcome reaches the script as an object", async () => {
		const executor = fakeExecutor(() => ({
			ok: true,
			text: '{"answer":42}',
			structured: { answer: 42 },
		}));
		const { runId } = start({
			script: [
				'export const meta = { name: "schema" };',
				'const r = await agent("q", { schema: { type: "object" } });',
				"return r.answer;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(42);
		expect(s.agents[0].structured).toBe(true);
		expect(executor.calls[0].req.opts.schema).toEqual({ type: "object" });
	});

	test("agent error: script receives null, snapshot marks error, run completes", async () => {
		const executor = fakeExecutor(() => ({ ok: false, error: "boom" }));
		const { runId } = start({
			script: [
				'export const meta = { name: "err" };',
				'const r = await agent("bad");',
				"return r === null;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(true);
		expect(s.agents[0].status).toBe("error");
		expect(s.agents[0].error).toBe("boom");
	});

	test("semaphore: concurrent executor calls never exceed the limit", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const executor = fakeExecutor(async (req) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 15));
			inFlight--;
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({
			script: [
				'export const meta = { name: "sem" };',
				"const thunks = [];",
				'for (let i = 0; i < 20; i++) thunks.push(() => agent("job " + i));',
				"const out = await parallel(thunks);",
				"return out.length;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toBe(20);
		expect(executor.calls.length).toBe(20);
		expect(maxInFlight).toBeLessThanOrEqual(WORKFLOW_LIMITS.maxConcurrentAgents);
		expect(maxInFlight).toBeGreaterThan(1);
	});

	test("Date.now / argless new Date / Math.random throw inside scripts; new Date(ms) works", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "poison" };',
				"const out = [];",
				'try { Date.now(); out.push("now-ok"); } catch { out.push("now-threw"); }',
				'try { new Date(); out.push("date-ok"); } catch { out.push("date-threw"); }',
				'try { Math.random(); out.push("rand-ok"); } catch { out.push("rand-threw"); }',
				'out.push(new Date(0).getTime() === 0 ? "date-ms-ok" : "date-ms-bad");',
				"return out;",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual([
			"now-threw",
			"date-threw",
			"rand-threw",
			"date-ms-ok",
		]);
	});

	test("script throw → run status error with the message", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: 'export const meta = { name: "throws" };\nthrow new Error("script exploded");',
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("error");
		expect(s.error).toBe("script exploded");
	});

	test("budget: total/spent/remaining track executor output tokens", async () => {
		const executor = echoExecutor({ input: 10, output: 250 });
		const { runId } = start({
			script: [
				'export const meta = { name: "budget" };',
				"const before = budget.remaining();",
				'await agent("a");',
				"return { total: budget.total, spent: budget.spent(), before, after: budget.remaining() };",
			].join("\n"),
			executor,
			budgetTotal: 1000,
		});
		const s = await waitForFinished(runId);
		expect(s.status).toBe("done");
		expect(s.result).toEqual({ total: 1000, spent: 250, before: 1000, after: 750 });
	});

	test("budget: unbounded when no total given", async () => {
		const executor = echoExecutor();
		const { runId } = start({
			script: [
				'export const meta = { name: "budget-unbounded" };',
				"return { total: budget.total, unbounded: budget.remaining() === Infinity };",
			].join("\n"),
			executor,
		});
		const s = await waitForFinished(runId);
		expect(s.result).toEqual({ total: null, unbounded: true });
	});

	test("cancelWorkflow mid-run: status cancelled, signal aborted, worker gone", async () => {
		let capturedCtx: WorkflowExecCtx | undefined;
		const executor = fakeExecutor(
			(_req, ctx) =>
				new Promise<WorkflowAgentOutcome>((resolve) => {
					capturedCtx = ctx;
					ctx.signal.addEventListener("abort", () =>
						resolve({ ok: false, error: "aborted" }),
					);
				}),
		);
		const { runId } = start({
			script: [
				'export const meta = { name: "cancel-me" };',
				'await agent("block forever");',
				'return "never";',
			].join("\n"),
			executor,
		});

		await waitUntil(() => executor.calls.length === 1);
		expect(cancelWorkflow(runId)).toBe(true);

		const s = await waitForFinished(runId);
		expect(s.status).toBe("cancelled");
		expect(s.result).toBeUndefined();
		expect(s.agents[0].status).toBe("cancelled");
		expect(capturedCtx?.signal.aborted).toBe(true);
		// Unregistered: a second cancel finds no live run.
		expect(cancelWorkflow(runId)).toBe(false);
	});

	test("startWorkflow validates script size", () => {
		expect(() =>
			start({
				script:
					'export const meta = { name: "big" };\n' +
					"//".padEnd(WORKFLOW_LIMITS.maxScriptChars, "x"),
				executor: echoExecutor(),
			}),
		).toThrow(/too large/);
	});

	test("journal replay: identical resume answers every call from the journal", async () => {
		const script = [
			'export const meta = { name: "replay" };',
			'const a = await agent("first");',
			'const b = await agent("second:" + a);',
			"return [a, b];",
		].join("\n");
		const executor1 = echoExecutor();
		const { runId } = start({ script, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.status).toBe("done");
		expect(executor1.calls.length).toBe(2);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(first.result);
		expect(executor2.calls.length).toBe(0);
		expect(resumed.agents.map((a) => a.cached)).toEqual([true, true]);
		// Cached entries were re-journaled, so resuming the resumed run works too.
		expect(readWorkflowJournal(resumedId).length).toBe(2);
	});

	test("journal replay: a changed prompt re-executes from the changed call, unrelated calls stay cached", async () => {
		const scriptV1 = [
			'export const meta = { name: "replay2" };',
			'const a = await agent("alpha");',
			'const b = await agent("beta");',
			'const c = await agent("gamma:" + a);',
			"return [a, b, c];",
		].join("\n");
		const executor1 = echoExecutor();
		const { runId } = start({ script: scriptV1, executor: executor1 });
		await waitForFinished(runId);
		expect(executor1.calls.length).toBe(3);

		const scriptV2 = scriptV1.replace('"alpha"', '"alpha-v2"');
		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script: scriptV2,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(["R:alpha-v2", "R:beta", "R:gamma:R:alpha-v2"]);
		// The changed call and its downstream re-executed; the untouched one
		// replayed from the journal.
		expect(executor2.calls.map((c) => c.req.prompt).sort()).toEqual([
			"alpha-v2",
			"gamma:R:alpha-v2",
		]);
		const bySeq = new Map(resumed.agents.map((a) => [a.seq, a]));
		expect(bySeq.get(0)?.cached).toBeUndefined();
		expect(bySeq.get(1)?.cached).toBe(true);
		expect(bySeq.get(2)?.cached).toBeUndefined();
	});
});

// ── Review-pass fixes (2026-07-10) ───────────────────────────────────────────

describe("hostile meta (static parser, zero evaluation)", () => {
	test("IIFE in a value is rejected and never executes", () => {
		(globalThis as any).__wfMetaPwned = undefined;
		expect(() =>
			parseWorkflowMeta(
				'export const meta = { name: (() => { globalThis.__wfMetaPwned = 1; return "x"; })() };\nreturn 1;',
			),
		).toThrow(/pure object literal/);
		expect((globalThis as any).__wfMetaPwned).toBeUndefined();
	});

	test("getters, computed keys, assignments, templates and identifier values are rejected", () => {
		const hostile = [
			'export const meta = { get name() { return "x"; } };',
			'export const meta = { ["na" + "me"]: "x" };',
			'export const meta = { name: globalThis.__x = "y" };',
			"export const meta = { name: `tpl${1}` };",
			"export const meta = { name: process.env.HOME };",
			'export const meta = { name: "ok", phases: [{ title: Date }] };',
		];
		for (const script of hostile) {
			expect(() => parseWorkflowMeta(script + "\nreturn 1;")).toThrow(
				/pure object literal/,
			);
		}
	});

	test("prototype-polluting keys are dropped, comments and trailing commas parse", () => {
		const { meta } = parseWorkflowMeta(
			[
				"export const meta = {",
				"\t// a comment",
				'\tname: "safe", /* inline */',
				'\t__proto__: { polluted: true },',
				"};",
				"return 1;",
			].join("\n"),
		);
		expect(meta.name).toBe("safe");
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
	});
});

describe("journal replay determinism", () => {
	const RACY_SCRIPT = [
		'export const meta = { name: "racy" };',
		"const [x, y] = await parallel([",
		'\tasync () => { const a1 = await agent("a1"); return agent("a2:" + a1); },',
		'\tasync () => { const b1 = await agent("b1"); return agent("b2:" + b1); },',
		"]);",
		"return [x, y];",
	].join("\n");

	test("parallel dependent chains replay fully even when live completion order differed", async () => {
		// Live run: a1 deliberately slow, so b's chain finishes first and the
		// journal's call order is a1, b1, b2, a2 — NOT replay call order.
		const executor1 = fakeExecutor(async (req) => {
			if (req.prompt === "a1") await new Promise((r) => setTimeout(r, 120));
			return { ok: true, text: `R:${req.prompt}` };
		});
		const { runId } = start({ script: RACY_SCRIPT, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.status).toBe("done");
		expect(executor1.calls.length).toBe(4);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script: RACY_SCRIPT,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.status).toBe("done");
		expect(resumed.result).toEqual(first.result);
		expect(executor2.calls.length).toBe(0);
		expect(resumed.agents.every((a) => a.cached)).toBe(true);
	});

	test("failed outcomes are journaled but re-executed on resume", async () => {
		const script = [
			'export const meta = { name: "retry" };',
			'const bad = await agent("flaky");',
			'const good = await agent("solid");',
			"return [bad, good];",
		].join("\n");
		const executor1 = fakeExecutor((req) =>
			req.prompt === "flaky"
				? { ok: false, error: "transient" }
				: { ok: true, text: `R:${req.prompt}` },
		);
		const { runId } = start({ script, executor: executor1 });
		const first = await waitForFinished(runId);
		expect(first.result).toEqual([null, "R:solid"]);
		// Both outcomes are journaled (audit trail)…
		expect(readWorkflowJournal(runId).length).toBe(2);

		// …but only the ok one replays; the failure gets a fresh execution.
		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toEqual(["R:flaky", "R:solid"]);
		expect(executor2.calls.map((c) => c.req.prompt)).toEqual(["flaky"]);
	});

	test("budget.spent() replays identically (original tokensOut reported for cached calls)", async () => {
		const script = [
			'export const meta = { name: "budgeted" };',
			'await agent("one");',
			'await agent("two");',
			"return budget.spent();",
		].join("\n");
		const executor1 = echoExecutor({ input: 10, output: 100 });
		const { runId } = start({ script, executor: executor1, budgetTotal: 1000 });
		const first = await waitForFinished(runId);
		expect(first.result).toBe(200);

		const executor2 = echoExecutor();
		const { runId: resumedId } = start({
			script,
			executor: executor2,
			resumeFromRunId: runId,
			budgetTotal: 1000,
		});
		const resumed = await waitForFinished(resumedId);
		expect(resumed.result).toBe(200);
		expect(executor2.calls.length).toBe(0);
		// Display totals stay this-run-only (cached calls cost nothing now).
		expect(resumed.totals.tokensOut).toBe(0);
	});
});

describe("worker containment & lifecycle", () => {
	test("script sees no Bun/process/fetch/WebSocket/globalThis (exfil/spawn surface shadowed)", async () => {
		const script = [
			'export const meta = { name: "scrubbed" };',
			"return [typeof Bun, typeof process, typeof fetch, typeof WebSocket, typeof XMLHttpRequest, typeof globalThis].join(',');",
		].join("\n");
		const { runId } = start({ script, executor: echoExecutor() });
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(snap.result).toBe(
			"undefined,undefined,undefined,undefined,undefined,undefined",
		);
	});

	test("a script cannot exit the worker process (process/globalThis unreachable)", async () => {
		// The containment that makes the close-handler's uncommanded-exit case
		// rare: a script has no reachable path to process.exit / self.close.
		const script = [
			'export const meta = { name: "no-exit" };',
			'try { process.exit(0); } catch (e) { return "blocked:" + e.constructor.name; }',
			'return "escaped";',
		].join("\n");
		const { runId } = start({ script, executor: echoExecutor() });
		const snap = await waitForFinished(runId);
		expect(snap.status).toBe("done");
		expect(String(snap.result)).toMatch(/^blocked:TypeError/);
	});
});

describe("snapshot payload bounds", () => {
	test("log lines, labels and errors are truncated in the snapshot", async () => {
		const script = [
			'export const meta = { name: "bounded" };',
			'log("x".repeat(10_000));',
			'await agent("p".repeat(5_000), { label: "L".repeat(5_000) });',
			"return 1;",
		].join("\n");
		const executor = fakeExecutor(() => ({ ok: false, error: "E".repeat(50_000) }));
		const { runId } = start({ script, executor });
		const snap = await waitForFinished(runId);
		expect(snap.logs[0].message.length).toBeLessThanOrEqual(501);
		expect(snap.agents[0].label.length).toBeLessThanOrEqual(201);
		expect((snap.agents[0].error || "").length).toBeLessThanOrEqual(1001);
	});
});
