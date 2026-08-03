import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as mod from "./run-journal";
import * as agent from "./agent-runner";
import * as shared from "./runner-shared";
import type { StreamEvent } from "./run-events";

// __setActiveRunsPathForTest repoints the LIVE ACTIVE_RUNS_PATH binding, so
// agent-runner.ts's own (already-cached, possibly earlier-imported-with-the-
// real-HOME) bare import of ./run-journal picks the scratch path up too —
// unlike a plain env-var-before-import, which only affects whichever test
// file happens to trigger the FIRST bare import of ./run-journal in the
// whole `bun test` process (order-dependent, and this file previously
// journaled into — and read back — the developer's real active-runs.json
// when run as part of the full suite).
let dir: string;
let oldJournal: string;
let oldForceLimit: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "backstage-run-journal-test-"));
	oldForceLimit = process.env.OPENSESSION_FORCE_LIMIT;
	oldJournal = mod.__setActiveRunsPathForTest(join(dir, "active-runs.json"));
});

afterEach(() => {
	mod.__setActiveRunsPathForTest(oldJournal);
	if (oldForceLimit === undefined) delete process.env.OPENSESSION_FORCE_LIMIT;
	else process.env.OPENSESSION_FORCE_LIMIT = oldForceLimit;
	rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
	it("preserves human-confirmed tool policy across restart drains", async () => {
		mod.journalSet({
			runKey: "run-1",
			bksSessionId: "bks-1",
			claudeSessionId: "engine-1",
			prompt: "continue",
			cwd: "/tmp",
			mcpServers: [],
			deniedTools: { mcp__danger__delete: "No deletes" },
			confirmTools: { mcp__stripe__create_refund: "Create a refund" },
			model: "opencode/openai/gpt-5.6-terra",
			selectedModel: "dial/medium",
			transientFallback: true,
			fallbackModel: "gpt-5.5",
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		const [run] = mod.takeInterruptedRuns();
		expect(run.confirmTools).toEqual({
			mcp__stripe__create_refund: "Create a refund",
		});
		expect(run.deniedTools).toEqual({ mcp__danger__delete: "No deletes" });
		expect(run.fallbackModel).toBe("gpt-5.5");
		expect(run.selectedModel).toBe("dial/medium");
		expect(run.transientFallback).toBe(true);
		// Returned records carry no claim stamp…
		expect(run.claimedAt).toBeUndefined();
		// …but the on-disk record survives as CLAIMED (not wiped) until the
		// resume outcome re-registers or clears it, so a restart that kills the
		// sweep mid-reattach hands the run to the next boot instead of losing it.
		const [claimed] = mod.activeRunRecords();
		expect(claimed.runKey).toBe("run-1");
		expect(claimed.claimedAt).toBeTruthy();
		// The same process never takes an already-claimed run twice.
		expect(mod.takeInterruptedRuns()).toEqual([]);
	});

	it("emits recovered run stream events during restart resume", async () => {
		process.env.OPENSESSION_FORCE_LIMIT = "1";
		mod.journalSet({
			runKey: "run-2",
			bksSessionId: "bks-2",
			claudeSessionId: "engine-2",
			prompt: "continue",
			cwd: "/tmp",
			model: "claude-fable-5",
			startedAt: "2026-07-02T00:00:00.000Z",
		});

		let resolveTerminal!: (value: { id?: string; event?: StreamEvent }) => void;
		const terminal = new Promise<{ id?: string; event?: StreamEvent }>((resolve) => {
			resolveTerminal = resolve;
		});
		const observed = new Promise<{ id: string; event: unknown }>((resolve) => {
			const resumed = agent.resumeInterruptedRuns(
				(id, event) => resolveTerminal({ id, event }),
				undefined,
				undefined,
				undefined,
				(id: string, event: unknown) => resolve({ id, event }),
			);
			expect(resumed).toEqual(["bks-2"]);
		});

		const result = await Promise.race([
			observed,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("resume event callback timed out")), 1000),
			),
		]);

		expect(result).toMatchObject({
			id: "bks-2",
			event: {
				type: "done",
				provider: "opencode",
				model: "opencode/anthropic/claude-fable-5",
				usageLimitExhausted: true,
			},
		});
		await expect(terminal).resolves.toMatchObject({
			id: "bks-2",
			event: {
				type: "done",
				usageLimitExhausted: true,
			},
		});
	});

	it("recognizes malformed recovered tool-output envelopes without matching real answers", () => {
		expect(
			agent.recoveredResultNeedsContinuation({
				type: "done",
				sessionId: "engine-1",
				result: '[your bash cd /tmp && ffmpeg ...]:\n=== raw ssim output ===',
				provider: "opencode",
				model: "opencode/anthropic/claude-opus-5",
			}),
		).toBe(true);
		// MCP tool ids must match too — 2026-07-29: a turn recited fabricated
		// `[your tella_create_source]:` results the builtin-name regex missed.
		expect(
			agent.recoveredResultNeedsContinuation({
				type: "done",
				sessionId: "engine-1",
				result: '[your tella_create_source]:\n{"source":{"id":"src_fabricated"}}',
				provider: "opencode",
				model: "opencode/anthropic/claude-opus-5",
			}),
		).toBe(true);
		expect(
			agent.recoveredResultNeedsContinuation({
				type: "done",
				sessionId: "engine-1",
				result: "The proxy GOP is 60 frames, or two seconds at 30fps.",
				provider: "opencode",
				model: "opencode/anthropic/claude-opus-5",
			}),
		).toBe(false);
		// Prose that merely mentions the envelope shape mid-answer stays a
		// real answer — the match is anchored to the start of the text.
		expect(
			agent.recoveredResultNeedsContinuation({
				type: "done",
				sessionId: "engine-1",
				result: "The leak shape starts with `[your bash …]:` in assistant text.",
				provider: "opencode",
				model: "opencode/anthropic/claude-opus-5",
			}),
		).toBe(false);
		expect(
			agent.recoveredResultNeedsContinuation({
				type: "done",
				sessionId: "engine-1",
				result: "Done! (no text output)",
				provider: "opencode",
				model: "opencode/anthropic/claude-opus-5",
			}),
		).toBe(true);
	});

	it("flags fabricated tool transcripts in assistant text (both observed costumes)", () => {
		// Costume 1 (2026-07-29 morning): Meridian's result-delivery envelope
		// authored by the model, MCP tool name included.
		expect(
			shared.looksLikeFabricatedToolTranscript(
				'[your tella_create_source]:\n{"source":{"id":"src_fabricated"}}',
			),
		).toBe(true);
		// Costume 2 (same day, +1h): UI duration chip + raw tool-input JSON,
		// and todowrite's canonical result string, narrated as text.
		expect(
			shared.looksLikeFabricatedToolTranscript(
				'I\'ll start.\n\n\n– 5s\n{"todos":[{"content":"Find the view","status":"in_progress"}]}',
			),
		).toBe(true);
		expect(
			shared.looksLikeFabricatedToolTranscript(
				"Todos have been modified successfully. Ensure that you continue to use the todo list.",
			),
		).toBe(true);
		// Costume 3 (2026-07-29 late morning, bks-019fad97): a raw function-call
		// block written as text, invented output inline, turn ended right after.
		expect(
			shared.looksLikeFabricatedToolTranscript(
				'I\'ll trace how the report-back gets injected.\n\n\n<invoke name="Bash">\n<parameter name="command">grep -rn "reportBack" src/agents/slack/sessions-tools.ts | head -40</parameter>\n</invoke>\n\n\n347:      const spawn_task = tool({\n',
			),
		).toBe(true);
		// A bare mention of the tag in code discussion (no parameter tag) stays
		// clean.
		expect(
			shared.looksLikeFabricatedToolTranscript(
				'The harness wraps each call in an <invoke name="..."> element.',
			),
		).toBe(false);
		// Legit prose stays clean: markdown bullets use ASCII hyphens, and an
		// en-dash duration inside a sentence has no JSON line after it.
		expect(
			shared.looksLikeFabricatedToolTranscript(
				"Here is the plan:\n- 5s timeout for polls\n- retry twice",
			),
		).toBe(false);
		expect(
			shared.looksLikeFabricatedToolTranscript("Timings:\n– 5s for boot\nthen the cache warms."),
		).toBe(false);
	});
});
