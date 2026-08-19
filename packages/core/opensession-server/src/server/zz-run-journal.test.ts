import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as mod from "./run-journal";
import * as agent from "./agent-runner";
import { clearRunState, getRunState, transitionRunState } from "./run-state";
import * as shared from "./runner-shared";
import type { StreamEvent } from "./run-events";
import { makeFakeEngine } from "./testing/fake-engine";

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
	agent.__setEngineForTest(null);
	agent.__setAbortDetachedForTest(null);
	agent.__setReattachForTest(null);
	agent.__setLocalHostResumeForTest(null);
	mod.__setActiveRunsPathForTest(oldJournal);
	if (oldForceLimit === undefined) delete process.env.OPENSESSION_FORCE_LIMIT;
	else process.env.OPENSESSION_FORCE_LIMIT = oldForceLimit;
	rmSync(dir, { recursive: true, force: true });
});

describe("run journal", () => {
	it("keeps interrupted and reattaching sessions busy until recovery settles", () => {
		const sessionId = `recovery-${crypto.randomUUID()}`;
		try {
			transitionRunState(sessionId, "boot_journal_found", undefined, () => {});
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
			transitionRunState(sessionId, "reattach_start", undefined, () => {});
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
			transitionRunState(sessionId, "run_failed", undefined, () => {});
			expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
		} finally {
			clearRunState(sessionId);
		}
	});

	it("settles an exhausted recovery with a visible terminal error", () => {
		const sessionId = `exhausted-${crypto.randomUUID()}`;
		const runKey = `run-${crypto.randomUUID()}`;
		const startedAt = new Date().toISOString();
		mod.journalSet({
			runKey,
			osSessionId: sessionId,
			claudeSessionId: `engine-${crypto.randomUUID()}`,
			cwd: "/tmp",
			kind: "prompt-resume",
			resumeAttempts: agent.MAX_BOOT_RESUME_ATTEMPTS,
			firstJournaledAt: startedAt,
			startedAt,
		});
		// Simulate the fresh process: journalSet marked the old process running,
		// while restart recovery rebuilds state from the journal on boot.
		clearRunState(sessionId);
		expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
		let terminal: StreamEvent | undefined;
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		try {
			const handled = agent.resumeInterruptedRuns((_id, event) => {
				terminal = event;
				throw new Error("observer failed");
			});
			expect(handled).toEqual([sessionId]);
			expect(terminal).toMatchObject({
				type: "error",
				content: expect.stringContaining("restart recovery attempts"),
			});
			expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
			expect(mod.activeRunRecords()).toEqual([]);
		} finally {
			errorLog.mockRestore();
			clearRunState(sessionId);
		}
	});

	it("cancels a journal-owned recovery before its queued worker starts", () => {
		const sessionId = `queued-recovery-${crypto.randomUUID()}`;
		const runKey = `run-${crypto.randomUUID()}`;
		try {
			mod.journalSet({
				runKey,
				osSessionId: sessionId,
				claudeSessionId: `engine-${crypto.randomUUID()}`,
				cwd: "/tmp",
				startedAt: new Date().toISOString(),
			});
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

			expect(agent.cancelAgentRun(sessionId)).toBe(true);

			expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
			expect(mod.activeRunRecords().some((run) => run.runKey === runKey)).toBe(false);
		} finally {
			clearRunState(sessionId);
		}
	});

	it("keeps an active cancelled recovery reserved until its worker exits", async () => {
		const sessionId = `active-recovery-${crypto.randomUUID()}`;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = makeFakeEngine([{ kind: "clean", gate }]);
		agent.__setEngineForTest(fake.engine);
		mod.journalSet({
			runKey: `run-${crypto.randomUUID()}`,
			osSessionId: sessionId,
			prompt: "continue",
			cwd: "/tmp",
			model: "claude-fable-5",
			startedAt: new Date().toISOString(),
		});
		clearRunState(sessionId);

		try {
			agent.resumeInterruptedRuns();
			while (fake.calls.length === 0) await Bun.sleep(5);

			expect(agent.cancelAgentRun(sessionId)).toBe(true);
			expect(getRunState(sessionId)).toBe("stopped");
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

			release();
			while (agent.isAgentSessionBusy(sessionId)) await Bun.sleep(5);

			agent.markSessionStarting(sessionId);
			expect(getRunState(sessionId)).toBe("starting");
			agent.unmarkSessionStarting(sessionId);
			transitionRunState(sessionId, "start_aborted", undefined, () => {});
		} finally {
			release();
			clearRunState(sessionId);
		}
	});

	it("latches Stop while a prompt is still preparing", async () => {
		const sessionId = `preparing-${crypto.randomUUID()}`;
		const fake = makeFakeEngine([{ kind: "clean" }]);
		agent.__setEngineForTest(fake.engine);
		const run = (startToken: string) => agent.runAgent({
			prompt: "continue",
			cwd: "/tmp",
			mcpServers: [],
			model: "claude-fable-5",
			fallbackModel: "none",
			journal: { osSessionId: sessionId, kind: "prompt" },
			startToken,
		});

		try {
			const stoppedToken = agent.markSessionStarting(sessionId);
			expect(agent.cancelAgentRun(sessionId)).toBe(true);
			const replacementToken = agent.markSessionStarting(sessionId);
			for await (const _event of run(stoppedToken)) {}
			expect(fake.calls).toHaveLength(0);
			agent.unmarkSessionStarting(sessionId, stoppedToken);
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);

			for await (const _event of run(replacementToken)) {}
			expect(fake.calls).toHaveLength(1);
			agent.unmarkSessionStarting(sessionId, replacementToken);
		} finally {
			agent.unmarkSessionStarting(sessionId);
			clearRunState(sessionId);
		}
	});

	it("latches Stop across concurrent prompt preparations", async () => {
		const sessionId = `concurrent-preparing-${crypto.randomUUID()}`;
		const fake = makeFakeEngine([{ kind: "clean" }]);
		agent.__setEngineForTest(fake.engine);
		const run = (startToken: string) => agent.runAgent({
			prompt: "continue",
			cwd: "/tmp",
			mcpServers: [],
			model: "claude-fable-5",
			fallbackModel: "none",
			journal: { osSessionId: sessionId, kind: "prompt" },
			startToken,
		});

		const firstToken = agent.markSessionStarting(sessionId);
		const secondToken = agent.markSessionStarting(sessionId);
		try {
			expect(agent.cancelAgentRun(sessionId)).toBe(true);
			for await (const _event of run(firstToken)) {}
			for await (const _event of run(secondToken)) {}
			expect(fake.calls).toHaveLength(0);
		} finally {
			agent.unmarkSessionStarting(sessionId, firstToken);
			agent.unmarkSessionStarting(sessionId, secondToken);
			clearRunState(sessionId);
		}
	});

	it("bridges pending preparations left by the pre-token hot-reload global", () => {
		const sessionId = `legacy-preparing-${crypto.randomUUID()}`;
		const g = globalThis as any;
		const previousPending = g.__pendingSessionStarts;
		const previousCancelled = g.__cancelledSessionRuns;
		try {
			g.__pendingSessionStarts = new Set([sessionId]);
			g.__cancelledSessionRuns = new Set();
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
			expect(agent.cancelAgentRun(sessionId)).toBe(true);
			expect(g.__cancelledSessionRuns.has(sessionId)).toBe(true);
		} finally {
			g.__pendingSessionStarts = previousPending;
			g.__cancelledSessionRuns = previousCancelled;
			clearRunState(sessionId);
		}
	});

	it("does not clear a replacement journal that reuses a cancelled recovery run key", () => {
		const sessionId = `replacement-${crypto.randomUUID()}`;
		const runKey = `engine-${crypto.randomUUID()}`;
		const oldStartedAt = new Date(Date.now() - 1000).toISOString();
		try {
			mod.journalSet({ runKey, osSessionId: sessionId, cwd: "/old", startedAt: oldStartedAt });
			const old = mod.activeRunRecords().find((run) => run.runKey === runKey)!;
			mod.journalClear(runKey);
			mod.journalSet({
				runKey,
				osSessionId: sessionId,
				cwd: "/replacement",
				startedAt: new Date().toISOString(),
			});

			expect(mod.journalClearIfLineage(old)).toBe(false);
			expect(mod.activeRunRecords()).toContainEqual(
				expect.objectContaining({ runKey, osSessionId: sessionId, cwd: "/replacement" }),
			);
		} finally {
			mod.journalClear(runKey);
			clearRunState(sessionId);
		}
	});

	it("resets the consecutive recovery fuse after a live turn reattaches", () => {
		const sessionId = `attached-${crypto.randomUUID()}`;
		const runKey = `engine-${crypto.randomUUID()}`;
		const startedAt = new Date().toISOString();
		try {
			mod.journalSet({ runKey, osSessionId: sessionId, cwd: "/tmp", startedAt });
			const started = mod.journalStartRecovery(mod.activeRunRecords()[0]);
			expect(started.resumeAttempts).toBe(1);
			expect(started.lastResumeAt).toBeTruthy();

			const attached = mod.journalMarkRecoveryAttached(started);
			expect(attached?.resumeAttempts).toBe(0);
			expect(attached?.lastResumeAt).toBeUndefined();
			expect(mod.activeRunRecords()[0].resumeAttempts).toBe(0);

			const nextBoot = mod.journalStartRecovery(attached!);
			expect(nextBoot.resumeAttempts).toBe(1);
		} finally {
			mod.journalClear(runKey);
			clearRunState(sessionId);
		}
	});

	it("does not reset the recovery fuse on a replacement lineage", () => {
		const sessionId = `attached-replacement-${crypto.randomUUID()}`;
		const runKey = `engine-${crypto.randomUUID()}`;
		try {
			mod.journalSet({
				runKey,
				osSessionId: sessionId,
				cwd: "/old",
				startedAt: new Date(Date.now() - 1000).toISOString(),
			});
			const old = mod.journalStartRecovery(mod.activeRunRecords()[0]);
			mod.journalClear(runKey);
			mod.journalSet({
				runKey,
				osSessionId: sessionId,
				cwd: "/replacement",
				startedAt: new Date().toISOString(),
				resumeAttempts: 2,
			});

			expect(mod.journalMarkRecoveryAttached(old)).toBeUndefined();
			expect(mod.activeRunRecords()[0]).toMatchObject({ cwd: "/replacement", resumeAttempts: 2 });
		} finally {
			mod.journalClear(runKey);
			clearRunState(sessionId);
		}
	});

	it("copies account and reviewer policy into every journal shape", () => {
		const record = mod.buildRunJournalRecord(
			{
				accountId: "account-1",
				accountStrict: true,
				usageCredits: false,
				prReviewer: "tellahq/platform",
			},
			{
				runKey: "policy",
				cwd: "/tmp",
				claudeSessionId: "engine-policy",
			},
		);
		expect(record).toMatchObject({
			accountId: "account-1",
			accountStrict: true,
			usageCredits: false,
			prReviewer: "tellahq/platform",
		});
	});

	it("settles headless journal-owned runs on their terminal event", async () => {
		const sessionId = `headless-${crypto.randomUUID()}`;
		const fake = makeFakeEngine([{ kind: "clean" }]);
		agent.__setEngineForTest(fake.engine);
		for await (const _event of agent.runAgent({
			prompt: "wake",
			cwd: "/tmp",
			mcpServers: [],
			model: "claude-fable-5",
			fallbackModel: "none",
			journal: { osSessionId: sessionId, kind: "goal" },
		})) {}
		expect(getRunState(sessionId)).toBe("idle");
		expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
	});

	it("keeps a kind-only run busy for its full outer fallback lifetime", async () => {
		const sessionId = `linear-${crypto.randomUUID()}`;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = makeFakeEngine([{ kind: "clean", gate }]);
		agent.__setEngineForTest(fake.engine);
		const running = (async () => {
			for await (const _event of agent.runAgent({
				prompt: "triage",
				cwd: "/tmp",
				mcpServers: [],
				model: "claude-fable-5",
				fallbackModel: "none",
				journal: { kind: "linear" },
				transcriptSessionId: sessionId,
			})) {}
		})();
		try {
			while (fake.calls.length < 1) await Bun.sleep(5);
			expect(agent.isAgentSessionBusy(sessionId)).toBe(true);
			expect(agent.cancelAgentRun(sessionId)).toBe(true);
		} finally {
			release();
			await running;
		}
		expect(agent.isAgentSessionBusy(sessionId)).toBe(false);
	});

	it("does not let a busy loser settle the winning turn", async () => {
		const sessionId = `busy-loser-${crypto.randomUUID()}`;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fake = makeFakeEngine([
			{ kind: "clean", gate },
			{ kind: "events", events: [{ type: "error", content: "Session is busy" }] },
		]);
		agent.__setEngineForTest(fake.engine);
		const run = (startToken: string) => agent.runAgent({
			prompt: "run",
			cwd: "/tmp",
			mcpServers: [],
			model: "claude-fable-5",
			fallbackModel: "none",
			journal: { osSessionId: sessionId, kind: "prompt" },
			startToken,
		});

		const winnerToken = agent.markSessionStarting(sessionId);
		const winner = (async () => {
			for await (const _event of run(winnerToken)) {}
			agent.unmarkSessionStarting(sessionId, winnerToken);
		})();
		try {
			while (fake.calls.length < 1) await Bun.sleep(5);
			const loserToken = agent.markSessionStarting(sessionId);
			for await (const _event of run(loserToken)) {}
			agent.unmarkSessionStarting(sessionId, loserToken);
			expect(getRunState(sessionId)).toBe("running");

			release();
			await winner;
			expect(getRunState(sessionId)).toBe("idle");
		} finally {
			release();
			await winner;
			agent.unmarkSessionStarting(sessionId);
			clearRunState(sessionId);
		}
	});

	it("does not notify for a rejected record when the same session will recover", () => {
		const sessionId = `mixed-recovery-${crypto.randomUUID()}`;
		const startedAt = new Date().toISOString();
		const valid: mod.ActiveRunRecord = {
			runKey: "valid",
			osSessionId: sessionId,
			cwd: "/tmp",
			startedAt,
		};
		const unsafe: mod.ActiveRunRecord = {
			...valid,
			runKey: "unsafe",
			kind: "prompt-resume-rerun",
		};

		const result = agent.sanitizeInterruptedRuns([unsafe, valid]);

		expect(result.interrupted).toEqual([valid]);
		expect(result.quarantined).toContainEqual({
			run: unsafe,
			reason: "recursive_recovery_kind",
			notify: false,
		});
	});

	it("aborts a discarded duplicate's different detached engine session", async () => {
		const sessionId = `duplicate-engine-${crypto.randomUUID()}`;
		const oldEngine = `engine-old-${crypto.randomUUID()}`;
		const keptEngine = `engine-kept-${crypto.randomUUID()}`;
		const now = Date.now();
		const aborted: string[] = [];
		agent.__setAbortDetachedForTest((async (run: mod.ActiveRunRecord) => {
			aborted.push(run.claudeSessionId!);
			return true;
		}) as typeof import("./opencode-runner").abortDetachedOpencodeTurn);
		agent.__setReattachForTest((async (run: mod.ActiveRunRecord) => {
			const stream = (async function* () {
				yield { type: "done", sessionId: run.claudeSessionId, result: "done" } as StreamEvent;
			})();
			(stream as any).cancelDetachedTurn = async () => {};
			return stream;
		}) as any);
		mod.journalSet({
			runKey: `run-old-${crypto.randomUUID()}`,
			osSessionId: sessionId,
			claudeSessionId: oldEngine,
			serverKey: `server-${crypto.randomUUID()}`,
			cwd: "/tmp",
			startedAt: new Date(now - 1_000).toISOString(),
		});
		mod.journalSet({
			runKey: `run-kept-${crypto.randomUUID()}`,
			osSessionId: sessionId,
			claudeSessionId: keptEngine,
			serverKey: `server-${crypto.randomUUID()}`,
			cwd: "/tmp",
			startedAt: new Date(now).toISOString(),
		});
		clearRunState(sessionId);

		try {
			agent.resumeInterruptedRuns();
			const deadline = Date.now() + 2_000;
			while (!aborted.length && Date.now() < deadline) await Bun.sleep(5);
			expect(aborted).toEqual([oldEngine]);
			while (agent.isAgentSessionBusy(sessionId) && Date.now() < deadline) await Bun.sleep(5);
		} finally {
			clearRunState(sessionId);
		}
	});

	it("does not abort a discarded duplicate when the kept recovery owns the same engine session", async () => {
		const sessionId = `duplicate-same-engine-${crypto.randomUUID()}`;
		const engineId = `engine-${crypto.randomUUID()}`;
		const now = Date.now();
		const aborted: string[] = [];
		agent.__setAbortDetachedForTest((async (run: mod.ActiveRunRecord) => {
			aborted.push(run.claudeSessionId!);
			return true;
		}) as typeof import("./opencode-runner").abortDetachedOpencodeTurn);
		agent.__setReattachForTest((async (run: mod.ActiveRunRecord) => {
			const stream = (async function* () {
				yield { type: "done", sessionId: run.claudeSessionId, result: "done" } as StreamEvent;
			})();
			(stream as any).cancelDetachedTurn = async () => {};
			return stream;
		}) as any);
		for (const [suffix, startedAt] of [
			["old", new Date(now - 1_000).toISOString()],
			["kept", new Date(now).toISOString()],
		] as const) {
			mod.journalSet({
				runKey: `run-${suffix}-${crypto.randomUUID()}`,
				osSessionId: sessionId,
				claudeSessionId: engineId,
				serverKey: `server-${crypto.randomUUID()}`,
				cwd: "/tmp",
				startedAt,
			});
		}
		clearRunState(sessionId);

		try {
			agent.resumeInterruptedRuns();
			const deadline = Date.now() + 2_000;
			while (agent.isAgentSessionBusy(sessionId) && Date.now() < deadline) await Bun.sleep(5);
			expect(aborted).toEqual([]);
		} finally {
			clearRunState(sessionId);
		}
	});

	it("waits for a discarded duplicate's abort before starting the kept recovery", async () => {
		const sessionId = `duplicate-abort-gate-${crypto.randomUUID()}`;
		const now = Date.now();
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		let reattachCalls = 0;
		agent.__setAbortDetachedForTest((async () => {
			await abortGate;
			return true;
		}) as typeof import("./opencode-runner").abortDetachedOpencodeTurn);
		agent.__setReattachForTest((async (run: mod.ActiveRunRecord) => {
			reattachCalls++;
			const stream = (async function* () {
				yield { type: "done", sessionId: run.claudeSessionId, result: "done" } as StreamEvent;
			})();
			(stream as any).cancelDetachedTurn = async () => {};
			return stream;
		}) as any);
		for (const [suffix, startedAt] of [
			["old", new Date(now - 1_000).toISOString()],
			["kept", new Date(now).toISOString()],
		] as const) {
			mod.journalSet({
				runKey: `run-${suffix}-${crypto.randomUUID()}`,
				osSessionId: sessionId,
				claudeSessionId: `engine-${suffix}-${crypto.randomUUID()}`,
				serverKey: `server-${crypto.randomUUID()}`,
				cwd: "/tmp",
				startedAt,
			});
		}
		clearRunState(sessionId);

		try {
			agent.resumeInterruptedRuns();
			await Bun.sleep(50);
			expect(reattachCalls).toBe(0);

			releaseAbort();
			const deadline = Date.now() + 2_000;
			while (reattachCalls === 0 && Date.now() < deadline) await Bun.sleep(5);
			expect(reattachCalls).toBe(1);
			while (agent.isAgentSessionBusy(sessionId) && Date.now() < deadline) await Bun.sleep(5);
		} finally {
			releaseAbort();
			clearRunState(sessionId);
		}
	});

	it("starts the kept recovery after a discarded duplicate's abort times out", async () => {
		const sessionId = `duplicate-abort-timeout-${crypto.randomUUID()}`;
		const now = Date.now();
		let reattachCalls = 0;
		let abortCancelled = false;
		agent.__setAbortDetachedForTest((async (_run, signal) =>
			new Promise<boolean>((resolve) => {
				signal?.addEventListener("abort", () => {
					abortCancelled = true;
					resolve(false);
				}, { once: true });
			})) as typeof import("./opencode-runner").abortDetachedOpencodeTurn);
		agent.__setReattachForTest((async (run: mod.ActiveRunRecord) => {
			reattachCalls++;
			const stream = (async function* () {
				yield { type: "done", sessionId: run.claudeSessionId, result: "done" } as StreamEvent;
			})();
			(stream as any).cancelDetachedTurn = async () => {};
			return stream;
		}) as any);
		for (const [suffix, startedAt] of [
			["old", new Date(now - 1_000).toISOString()],
			["kept", new Date(now).toISOString()],
		] as const) {
			mod.journalSet({
				runKey: `run-${suffix}-${crypto.randomUUID()}`,
				osSessionId: sessionId,
				claudeSessionId: `engine-${suffix}-${crypto.randomUUID()}`,
				serverKey: `server-${crypto.randomUUID()}`,
				cwd: "/tmp",
				startedAt,
			});
		}
		clearRunState(sessionId);
		const previousWait = agent.__setDetachedAbortWaitMsForTest(30);

		try {
			agent.resumeInterruptedRuns();
			const deadline = Date.now() + 2_000;
			while (reattachCalls === 0 && Date.now() < deadline) await Bun.sleep(5);
			expect(reattachCalls).toBe(1);
			expect(abortCancelled).toBe(true);
			while (agent.isAgentSessionBusy(sessionId) && Date.now() < deadline) await Bun.sleep(5);
		} finally {
			agent.__setDetachedAbortWaitMsForTest(previousWait);
			clearRunState(sessionId);
		}
	});

	it("deduplicates and bounds restart recovery while rejecting recursive records", () => {
		const now = Date.now();
		const records: mod.ActiveRunRecord[] = Array.from({ length: 40 }, (_, i) => ({
			runKey: `run-${i}`,
			osSessionId: `session-${i}`,
			prompt: `prompt ${i}`,
			cwd: "/tmp",
			mcpServers: [],
			kind: "prompt",
			firstJournaledAt: new Date(now - 60_000).toISOString(),
			startedAt: new Date(now - 40_000 + i).toISOString(),
		}));
		records.push({ ...records[0], runKey: "run-0-new", startedAt: new Date(now).toISOString() });
		records.push({ ...records[1], runKey: "recursive", kind: "prompt-resume-resume" });

		const result = agent.sanitizeInterruptedRuns(records, now);
		expect(result.interrupted).toHaveLength(agent.MAX_BOOT_RECOVERIES);
		expect(result.interrupted.find((r) => r.osSessionId === "session-0")?.runKey).toBe("run-0-new");
		expect(result.interrupted.some((r) => r.runKey === "recursive")).toBe(false);
		expect(result.quarantined.some((r) => r.run.runKey === "run-0" && r.reason === "duplicate_session")).toBe(true);
		expect(result.quarantined.some((r) => r.run.runKey === "recursive" && r.reason === "recursive_recovery_kind")).toBe(true);
	});

	it("rejects expired lineage and exhausted durable resume attempts", () => {
		const now = Date.now();
		const base: mod.ActiveRunRecord = {
			runKey: "base",
			osSessionId: "session-base",
			cwd: "/tmp",
			startedAt: new Date(now).toISOString(),
			firstJournaledAt: new Date(now).toISOString(),
		};
		const result = agent.sanitizeInterruptedRuns([
			{ ...base, runKey: "attempted", osSessionId: "attempted", resumeAttempts: agent.MAX_BOOT_RESUME_ATTEMPTS },
			{ ...base, runKey: "expired", osSessionId: "expired", firstJournaledAt: new Date(now - agent.MAX_RECOVERY_AGE_MS - 1).toISOString() },
		], now);
		expect(result.interrupted).toEqual([]);
		expect(result.quarantined.map((entry) => entry.reason).sort()).toEqual([
			"recovery_expired",
			"resume_attempts_exhausted",
		]);
	});

	it("keeps recovery kinds and prompts bounded across repeated restarts", () => {
		expect(agent.recoveryKind("prompt", "resume")).toBe("prompt-resume");
		expect(agent.recoveryKind("prompt-resume", "resume")).toBe("prompt-resume");
		expect(agent.recoveryKind("prompt-resume-rerun", "rerun")).toBe("prompt-rerun");
		const once = agent.resumeContinuationPrompt("original task");
		expect(agent.resumeContinuationPrompt(once)).toBe(once);
	});

	it("runs boot recovery with bounded concurrency", async () => {
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 20 }, () => async () => {
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active--;
		});
		await agent.runRecoveryQueue(tasks);
		expect(peak).toBe(agent.BOOT_RECOVERY_CONCURRENCY);
		expect(active).toBe(0);
	});

	it("continues draining recoveries after one worker task throws", async () => {
		let completed = false;
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		try {
			await agent.runRecoveryQueue([
				async () => {
					throw new Error("unexpected recovery failure");
				},
				async () => {
					completed = true;
				},
			]);
			expect(completed).toBe(true);
		} finally {
			errorLog.mockRestore();
		}
	});

	it("preserves human-confirmed tool policy across restart drains", async () => {
		mod.journalSet({
			runKey: "run-1",
			osSessionId: "bks-1",
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

	it("moves rejected recovery records into an inspectable quarantine", async () => {
		for (let i = 0; i < 5; i++) {
			mod.journalSet({ runKey: `batch-${i}`, cwd: "/tmp", mcpServers: [], startedAt: new Date().toISOString() });
		}
		mod.journalQuarantine([
			{ run: mod.activeRunRecords().find((run) => run.runKey === "batch-1")!, reason: "boot_recovery_limit", notify: true },
			{ run: mod.activeRunRecords().find((run) => run.runKey === "batch-3")!, reason: "duplicate_session", notify: false },
		]);
		expect(mod.activeRunRecords().map((run) => run.runKey).sort()).toEqual([
			"batch-0", "batch-2", "batch-4",
		]);
		const quarantine = await Bun.file(join(dir, "active-runs.quarantine.json")).json();
		expect(Object.values(quarantine).map((run: any) => run.quarantineReason).sort()).toEqual([
			"boot_recovery_limit",
			"duplicate_session",
		]);
	});

	it("preserves first-journaled time while incrementing recovery attempts", () => {
		const first = new Date(Date.now() - 10_000).toISOString();
		mod.journalSet({ runKey: "lineage", cwd: "/tmp", startedAt: first });
		const prepared = mod.journalStartRecovery(mod.activeRunRecords()[0]);
		expect(prepared.firstJournaledAt).toBe(first);
		expect(prepared.resumeAttempts).toBe(1);
		expect(prepared.lastResumeAt).toBeTruthy();
		mod.journalSet({ ...prepared, startedAt: new Date().toISOString() });
		expect(mod.activeRunRecords()[0].firstJournaledAt).toBe(first);
		expect(mod.activeRunRecords()[0].resumeAttempts).toBe(1);
	});

	it("emits recovered run stream events during restart resume", async () => {
		process.env.OPENSESSION_FORCE_LIMIT = "1";
		mod.journalSet({
			runKey: "run-2",
			osSessionId: "bks-2",
			claudeSessionId: "engine-2",
			prompt: "continue",
			cwd: "/tmp",
			model: "claude-fable-5",
			startedAt: new Date().toISOString(),
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

describe("restart recovery queue", () => {
	it("starts a starved recovery instead of declaring it dead", async () => {
		const gates: Array<() => void> = [];
		const gated = () =>
			new Promise<void>((resolve) => {
				gates.push(resolve);
			});
		// Four gated turns hold every queue slot (BOOT_RECOVERY_CONCURRENCY).
		// The fifth run is the one that used to be told "send the prompt again"
		// while its own engine turn kept running on a detached server.
		const fake = makeFakeEngine([
			{ kind: "clean", gate: gated() },
			{ kind: "clean", gate: gated() },
			{ kind: "clean", gate: gated() },
			{ kind: "clean", gate: gated() },
			{ kind: "clean" },
		]);
		agent.__setEngineForTest(fake.engine);
		const sessions = Array.from(
			{ length: 5 },
			(_, i) => `starved-${i}-${crypto.randomUUID()}`,
		);
		sessions.forEach((sessionId, i) => {
			mod.journalSet({
				runKey: `run-${sessionId}`,
				osSessionId: sessionId,
				claudeSessionId: `engine-${sessionId}`,
				prompt: "continue",
				cwd: "/tmp",
				model: "claude-fable-5",
				startedAt: new Date(Date.now() - i * 1000).toISOString(),
			});
			clearRunState(sessionId);
		});
		const waitMs = 300;
		const previousWait = agent.__setRecoveryQueueWaitMsForTest(waitMs);
		const terminals: StreamEvent[] = [];
		try {
			const resumedAt = Date.now();
			agent.resumeInterruptedRuns((_id, event) => {
				if (event) terminals.push(event);
			});
			// The four gated turns never end, so a fifth engine call can only
			// come from a recovery that started OUTSIDE the queue — and only
			// after the wait, which is what makes this the promotion and not a
			// free slot.
			while (fake.calls.length < 5) await Bun.sleep(5);
			expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(waitMs);
			// Never a failure report for a run whose engine is still working.
			expect(terminals.filter((event) => event.type === "error")).toEqual([]);
		} finally {
			agent.__setRecoveryQueueWaitMsForTest(previousWait);
			for (const open of gates) open();
			for (const sessionId of sessions) {
				while (agent.isAgentSessionBusy(sessionId)) await Bun.sleep(5);
				clearRunState(sessionId);
			}
		}
	});
});

describe("restart recovery reattach", () => {
	it("claims a snapshot-only local host before the generic wake can re-prompt", async () => {
		const sessionId = `local-host-snapshot-${crypto.randomUUID()}`;
		const hostId = `rh-${crypto.randomUUID()}`;
		const fake = makeFakeEngine([{ kind: "clean" }]);
		agent.__setEngineForTest(fake.engine);
		let resumeCalls = 0;
		agent.__setLocalHostResumeForTest(async (run) => {
			resumeCalls++;
			return (async function* () {
				yield {
					type: "init" as const,
					sessionId: run.claudeSessionId,
					provider: "pi",
					model: run.model,
				};
				yield {
					type: "done" as const,
					sessionId: run.claudeSessionId,
					provider: "pi",
					model: run.model,
					result: "PI_SURVIVED_RESTART",
				};
			})();
		});
		const snapshotRun: mod.ActiveRunRecord = {
			runKey: hostId,
			hostId,
			osSessionId: sessionId,
			claudeSessionId: `pi-${crypto.randomUUID()}`,
			prompt: "sleep, then finish once",
			promptEntryId: crypto.randomUUID(),
			cwd: "/tmp",
			model: "pi/anthropic/claude-sonnet-5",
			kind: "prompt",
			startedAt: new Date().toISOString(),
		};
		let resolveTerminal!: (event: StreamEvent) => void;
		const terminal = new Promise<StreamEvent>((resolve) => {
			resolveTerminal = resolve;
		});

		try {
			const resumed = agent.resumeInterruptedRuns(
				(_id, event) => event && resolveTerminal(event),
				undefined,
				undefined,
				undefined,
				undefined,
				[snapshotRun],
			);

			// resumeDrainedSessions receives this set synchronously, before the
			// asynchronous host attach starts, so it cannot launch a generic wake.
			expect(resumed).toEqual([sessionId]);
			await expect(terminal).resolves.toMatchObject({
				type: "done",
				result: "PI_SURVIVED_RESTART",
			});
			expect(resumeCalls).toBe(1);
			expect(fake.calls).toHaveLength(0);
			expect(mod.activeRunRecords()).toEqual([]);
		} finally {
			clearRunState(sessionId);
		}
	});

	it("does not let a reattached turn hold a queue slot", async () => {
		// Every one of these runs survived the restart on its own detached
		// server and is still executing. Following such a turn costs this
		// process nothing, so all five must attach at once — holding a slot
		// for the turn's whole lifetime is what starved the fifth run until
		// the queue-wait timer fired (2026-08-16).
		const attached: string[] = [];
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		agent.__setReattachForTest((async (run: any) => {
			attached.push(run.runKey);
			const stream = (async function* () {
				yield { type: "init", sessionId: run.claudeSessionId, provider: "opencode" };
				await gate;
				yield {
					type: "done",
					sessionId: run.claudeSessionId,
					provider: "opencode",
					result: "picked up where the restart left off",
				};
			})();
			(stream as any).cancelDetachedTurn = async () => {};
			return stream;
		}) as any);
		const sessions = Array.from(
			{ length: 5 },
			(_, i) => `reattach-${i}-${crypto.randomUUID()}`,
		);
		sessions.forEach((sessionId, i) => {
			mod.journalSet({
				runKey: `run-${sessionId}`,
				osSessionId: sessionId,
				claudeSessionId: `engine-${sessionId}`,
				serverKey: `shared:test-${i}`,
				prompt: "continue",
				cwd: "/tmp",
				model: "claude-fable-5",
				startedAt: new Date(Date.now() - i * 1000).toISOString(),
			});
			clearRunState(sessionId);
		});
		// Long enough that a fifth attach can only come from a freed slot,
		// never from the queue-wait timer starting the run outside the queue.
		const previousWait = agent.__setRecoveryQueueWaitMsForTest(30_000);
		try {
			const resumedAt = Date.now();
			agent.resumeInterruptedRuns();
			while (attached.length < 5) await Bun.sleep(5);
			expect(Date.now() - resumedAt).toBeLessThan(5_000);
		} finally {
			agent.__setRecoveryQueueWaitMsForTest(previousWait);
			agent.__setReattachForTest(null);
			openGate();
			for (const sessionId of sessions) {
				while (agent.isAgentSessionBusy(sessionId)) await Bun.sleep(5);
				clearRunState(sessionId);
			}
		}
	});
});
