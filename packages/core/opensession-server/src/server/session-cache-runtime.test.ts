import { describe, expect, test } from "bun:test";
import { enrichSessionRuntime } from "./session-cache";
import type { UnifiedSession } from "./types";

describe("session runtime enrichment", () => {
	test("clears stale indexed running state after the runtime settles", () => {
		const session = {
			id: "stale-indexed-runtime-test",
			isRunning: true,
			runStartedAt: "2026-08-22T12:00:00.000Z",
		} as UnifiedSession;

		enrichSessionRuntime([session]);

		expect(session.isRunning).toBe(false);
		expect(session.runStartedAt).toBeUndefined();
	});
});
