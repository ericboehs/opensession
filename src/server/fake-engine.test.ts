/**
 * The fake engine driving runAgent's real fallback walk — token-free coverage
 * for the paths we previously only ever exercised in production: clean
 * passthrough, usage-exhaustion hops (model_switch + same-family session
 * resume), and the two-transient-failures circuit breaker (the 2026-07-17
 * stolen-socket class).
 *
 * agent-runner's module graph is import-safe under bun test (no socket binds,
 * no tickers at module scope — the run-rpc bind lives behind
 * startRunRpcServer's NODE_ENV=test guard and is not on this graph anyway).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { __setEngineForTest, runAgent } from "./agent-runner";
import { __setActiveRunsPathForTest, activeRunRecords } from "./run-journal";
import type { StreamEvent } from "./run-events";
import { makeFakeEngine } from "./testing/fake-engine";

const journalTmp = `${mkdtempSync(`${tmpdir()}/fake-engine-test-`)}/active-runs.json`;
const prevJournal = __setActiveRunsPathForTest(journalTmp);

afterEach(() => {
	__setEngineForTest(null);
});
// Restore the journal path for any later test file in the suite.
process.on("beforeExit", () => __setActiveRunsPathForTest(prevJournal));

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const e of gen) out.push(e);
	return out;
}

const types = (events: StreamEvent[]) => events.map((e) => e.type);

describe("fake engine through runAgent", () => {
	test("clean turn passes through verbatim (no fallback configured)", async () => {
		const fake = makeFakeEngine([
			{
				kind: "clean",
				engineSessionId: "ses_fake1",
				text: ["hello ", "world"],
				tools: [{ name: "bash", input: { command: "ls" }, result: "ok" }],
			},
		]);
		__setEngineForTest(fake.engine);
		const events = await collect(
			runAgent({
				prompt: "do the thing",
				cwd: "/tmp",
				mcpServers: [],
				model: "claude-sonnet-5",
				fallbackModel: "none",
			}),
		);
		expect(types(events)).toEqual([
			"init",
			"text_chunk",
			"text_chunk",
			"tool_use",
			"tool_result",
			"done",
		]);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].model).toBe("opencode/anthropic/claude-sonnet-5");
		expect(fake.calls[0].prompt).toBe("do the thing");
		const done = events.at(-1)!;
		expect(done.sessionId).toBe("ses_fake1");
	});

	test("terminal error passes through when no fallback is configured", async () => {
		const fake = makeFakeEngine([
			{ kind: "error", content: "bridge disabled" },
		]);
		__setEngineForTest(fake.engine);
		const events = await collect(
			runAgent({
				prompt: "p",
				cwd: "/tmp",
				mcpServers: [],
				model: "claude-sonnet-5",
				fallbackModel: "none",
			}),
		);
		expect(types(events)).toEqual(["init", "error"]);
		expect(events[1].content).toBe("bridge disabled");
	});

	test("usage exhaustion hops to the strongest auto-eligible fallback", async () => {
		const fake = makeFakeEngine([
			{ kind: "usage_exhausted", engineSessionId: "ses_partial" },
			{ kind: "clean", text: ["done on fallback"] },
		]);
		__setEngineForTest(fake.engine);
		const events = await collect(
			runAgent({
				prompt: "keep going",
				cwd: "/tmp",
				mcpServers: [],
				model: "claude-sonnet-5",
				fallbackModel: "claude-opus-4-8",
				journal: { bksSessionId: "bks-test-hop", kind: "prompt" },
			}),
		);
		// The partial attempt's init passes through, its exhausted done is
		// swallowed, then the structured switch cue + the fallback model's clean
		// turn. The switch is a timeline event, never assistant text. The walk
		// prefers the strongest AUTO candidate over the
		// configured preference when that preference ranks lower in the tier
		// graph — sonnet's best auto hop today is gpt-5.6-sol (cross-family).
		expect(types(events)).toEqual([
			"init",
			"model_switch",
			"init",
			"text_chunk",
			"done",
		]);
		const sw = events[1];
		// fromModel is the picker-form id (resolveConcreteModel keeps native ids
		// native); toModel is the opencode-mapped hop target.
		expect(sw.fromModel).toBe("claude-sonnet-5");
		expect(sw.toModel).toBe("opencode/openai/gpt-5.6-sol");
		expect(sw.switchReason).toBe("out of credits");
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].model).toBe("opencode/openai/gpt-5.6-sol");
		// Cross-family hop: no engine-session resume — a fresh session, with the
		// empty-handoff note telling the model prior partial work may exist.
		expect(fake.calls[1].sessionId).toBeUndefined();
		expect(fake.calls[1].prompt).toContain("previous attempt");
		expect(fake.calls[1].journalKind).toBe("prompt-fallback");
	});

	test("two consecutive transient failures trip the infrastructure circuit breaker", async () => {
		const fake = makeFakeEngine([
			{ kind: "error", content: "fetch failed (socket hang up)" },
			{ kind: "error", content: "fetch failed (socket hang up)" },
			{ kind: "clean", text: ["should never run"] },
		]);
		__setEngineForTest(fake.engine);
		const events = await collect(
			runAgent({
				prompt: "p",
				cwd: "/tmp",
				mcpServers: [],
				model: "claude-sonnet-5",
				fallbackModel: "claude-opus-4-8",
				journal: { bksSessionId: "bks-test-breaker", kind: "prompt" },
			}),
		);
		const last = events.at(-1)!;
		expect(last.type).toBe("error");
		expect(last.content).toContain("infrastructure problem");
		// The walk stopped after the second transient death — no third model burned.
		expect(fake.calls).toHaveLength(2);
	});

	test("journals the selected model behind a transient fallback for restart recovery", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const fake = makeFakeEngine([
			{ kind: "error", content: "Our servers are currently overloaded" },
			{ kind: "clean", text: ["recovered"], gate },
		]);
		__setEngineForTest(fake.engine);
		const collecting = collect(
			runAgent({
				prompt: "p",
				cwd: "/tmp",
				mcpServers: [],
				model: "dial/medium",
				fallbackModel: "claude-opus-5",
				journal: { bksSessionId: "bks-test-transient-journal", kind: "prompt" },
			}),
		);
		while (fake.calls.length < 2) await Bun.sleep(5);

		const run = activeRunRecords().find(
			(record) => record.bksSessionId === "bks-test-transient-journal",
		);
		release();
		const events = await collecting;

		expect(run?.model).toBe("opencode/openai/gpt-5.6-terra");
		expect(run?.selectedModel).toBe("dial/medium");
		expect(run?.transientFallback).toBe(true);
		const switchEvent = events.find((event) => event.type === "model_switch");
		expect(switchEvent?.temporaryFallback).toBe(true);
	});

	test("script exhaustion fails loud instead of hanging", async () => {
		const fake = makeFakeEngine([]);
		__setEngineForTest(fake.engine);
		const events = await collect(
			runAgent({ prompt: "p", cwd: "/tmp", model: "claude-sonnet-5", fallbackModel: "none", mcpServers: [] }),
		);
		expect(events.at(-1)!.type).toBe("error");
		expect(events.at(-1)!.content).toContain("script exhausted");
	});
});
