/**
 * End-to-end consumer-loop test on the fake engine: runSessionPromptAndDrain
 * driving a real session file through runAgent → the event loop → persistence,
 * run-state FSM, busy lifecycle, and queue drain — with zero model spend.
 *
 * zz- prefix + dynamic imports in beforeAll (the zz-run-ws pattern): the
 * dangerous modules (run-session → interactive-mcp → startRunRpcServer) load
 * only after NODE_ENV=test is in effect and the chats dir is redirected.
 * __backstageBooted is set BEFORE those imports so module-scope tickers (the
 * /loop ticker etc.) never arm in the test process.
 *
 * Full-suite caveat: earlier test files may have already loaded sessions.ts /
 * session-cache.ts, freezing their SESSIONS_DIR consts on a different chats
 * dir — then our temp-dir session files are invisible to findSession. The
 * beforeAll detects that (probe session lookup) and the tests skip loudly
 * rather than touching the real store. Run this file directly for full
 * coverage: bun test src/server/zz-fake-run.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const tmp = mkdtempSync(`${tmpdir()}/zz-fake-run-`);

// Loaded dynamically in beforeAll — see header.
let runSession: typeof import("./run-session");
let agentRunner: typeof import("./agent-runner");
let sessionCache: typeof import("./session-cache");
let runState: typeof import("./run-state");
let queueState: typeof import("./queue-state");
let fakeEngineMod: typeof import("./testing/fake-engine");
let restoreChatsDir: (() => void) | null = null;
let restoreJournal: (() => void) | null = null;
let redirected = false;

function writeSessionFile(id: string, extra: Record<string, unknown> = {}) {
	writeFileSync(
		`${tmp}/${id}.json`,
		JSON.stringify({
			id,
			title: `Fake run ${id}`,
			model: "claude-sonnet-5",
			createdBy: "Test",
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			...extra,
		}),
	);
}

beforeAll(async () => {
	(globalThis as any).__backstageBooted = true;
	const paths = await import("./paths");
	const prevDir = paths.__setChatsDirForTest(tmp);
	restoreChatsDir = () => paths.__setChatsDirForTest(prevDir);
	const runJournal = await import("./run-journal");
	const prevJournal = runJournal.__setActiveRunsPathForTest(
		`${tmp}/active-runs.json`,
	);
	restoreJournal = () => runJournal.__setActiveRunsPathForTest(prevJournal);

	runSession = await import("./run-session");
	agentRunner = await import("./agent-runner");
	sessionCache = await import("./session-cache");
	runState = await import("./run-state");
	queueState = await import("./queue-state");
	fakeEngineMod = await import("./testing/fake-engine");

	// Redirect probe: a session file written to our temp dir must be visible
	// through findSession, or earlier suite files froze the store elsewhere.
	writeSessionFile("bks-zz-probe");
	sessionCache.invalidateSessionsCache();
	redirected = !!sessionCache.findSession("bks-zz-probe");
	if (!redirected) {
		console.warn(
			"[zz-fake-run] chats-dir redirect didn't take (module cache already " +
				"warm from earlier test files) — skipping; run this file directly.",
		);
	}
});

afterAll(() => {
	agentRunner?.__setEngineForTest(null);
	restoreJournal?.();
	restoreChatsDir?.();
	sessionCache?.invalidateSessionsCache();
});

const sessionJson = (id: string) =>
	JSON.parse(readFileSync(`${tmp}/${id}.json`, "utf-8"));

describe("fake-engine session runs (consumer loop end-to-end)", () => {
	test("clean run: engine id + usage persisted, FSM idle, settled", async () => {
		if (!redirected) return;
		const sid = "bks-zz-clean";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			{
				kind: "clean",
				engineSessionId: "ses_zz_clean",
				text: ["all done"],
				tools: [{ name: "bash", input: { command: "true" }, result: "ok" }],
			},
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "do the thing", "Test");

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].prompt).toContain("do the thing");
		const data = sessionJson(sid);
		// engineSessionPatch persisted the fake engine session for later resumes.
		expect(
			data.opencodeSessionId === "ses_zz_clean" ||
				data.claudeSessionId === "ses_zz_clean",
		).toBe(true);
		expect(data.lastEngineProvider).toBe("opencode");
		expect(data.usage?.inputTokens).toBe(100);
		expect(data.lastRunError).toBeUndefined();
		// Lifecycle fully settled: FSM at rest, engine not busy, queue empty.
		expect(runState.getRunState(sid)).toBe("idle");
		expect(
			agentRunner.isAgentSessionBusy("ses_zz_clean", undefined, sid),
		).toBe(false);
		expect(sessionCache.isRunSettled(sid)).toBe(true);
	});

	test("failed run: lastRunError recorded, FSM failed (still settled)", async () => {
		if (!redirected) return;
		const sid = "bks-zz-error";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		const fake = fakeEngineMod.makeFakeEngine([
			// Non-transient, non-usage error: surfaces directly (no fallback walk).
			{ kind: "error", content: "boom: unrecoverable test failure" },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		await runSession.runSessionPromptAndDrain(sid, "explode please", "Test");

		expect(fake.calls).toHaveLength(1);
		expect(sessionJson(sid).lastRunError?.message).toContain("boom");
		expect(runState.getRunState(sid)).toBe("failed");
		expect(sessionCache.isRunSettled(sid)).toBe(true);
		// The enriched list surfaces the FSM state.
		sessionCache.invalidateSessionsCache();
		const listed = sessionCache.findSession(sid);
		expect(listed?.runState).toBe("failed");
		expect(listed?.lastRunError?.message).toContain("boom");
	});

	test("prompt queued mid-turn drains as the next turn on the same engine session", async () => {
		if (!redirected) return;
		const sid = "bks-zz-queue";
		writeSessionFile(sid);
		sessionCache.invalidateSessionsCache();
		let releaseTurn1!: () => void;
		const gate = new Promise<void>((r) => (releaseTurn1 = r));
		const fake = fakeEngineMod.makeFakeEngine([
			{ kind: "clean", engineSessionId: "ses_zz_queue", text: ["turn 1"], gate },
			{ kind: "clean", text: ["turn 2"] },
		]);
		agentRunner.__setEngineForTest(fake.engine);

		const run = runSession.runSessionPromptAndDrain(sid, "first", "Test");
		// Wait for the engine to actually be inside turn 1, then queue while busy.
		while (fake.calls.length < 1) await Bun.sleep(5);
		// The session must be un-settled mid-turn — the don't-trust-turn_end rule.
		expect(sessionCache.isRunSettled(sid)).toBe(false);
		runSession.enqueuePrompt(sid, queueState.queueItem({ content: "second", user: "Test" }));
		releaseTurn1();
		await run;

		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1].prompt).toContain("second");
		// Turn 2 resumed the engine session turn 1 established.
		expect(fake.calls[1].sessionId).toBe("ses_zz_queue");
		expect(queueState.promptQueues.get(sid)?.length ?? 0).toBe(0);
		expect(runState.getRunState(sid)).toBe("idle");
		expect(sessionCache.isRunSettled(sid)).toBe(true);
	});
});
