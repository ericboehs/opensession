import { describe, expect, test } from "bun:test";
import { makeSubagentStallGuard } from "./opencode-runner";

// Regression tests for the 2026-08-03 bks-019fc798 wedge: a task child whose
// provider request hung emitted only housekeeping events (session.status
// retry ticks, session.updated bumps — the SSE envelope carries a top-level
// sessionID), each of which reset the family silence clock, so the guard sat
// armed for 25 minutes and never fired. Only CONTENT flow may reset the clock.

const PARENT = "ses_parent";
const CHILD = "ses_child";

function makeGuard() {
	return makeSubagentStallGuard(PARENT, () => {});
}

function partEvent(sessionID: string, part: Record<string, unknown>) {
	return {
		type: "message.part.updated",
		properties: { sessionID, part: { sessionID, ...part } },
	};
}

describe("makeSubagentStallGuard.noteEvent", () => {
	test("content events reset the silence clock; housekeeping does not", () => {
		const guard = makeGuard();
		const t0 = Date.now();

		guard.noteEvent(partEvent(PARENT, { id: "prt1", type: "tool", tool: "task" }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);

		// session.status / session.updated for the parent carry a top-level
		// sessionID but are NOT progress — the clock must keep running.
		guard.noteEvent({ type: "session.status", properties: { sessionID: PARENT, status: { type: "retry" } } });
		guard.noteEvent({ type: "session.updated", properties: { sessionID: PARENT, info: { id: PARENT } } });
		guard.noteEvent({ type: "permission.asked", properties: { sessionID: PARENT } });
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);

		// Real content resets it.
		guard.noteEvent(partEvent(PARENT, { id: "prt2", type: "text", text: "hi" }));
		expect(guard.quietFor(Date.now())).toBeLessThan(1_000);
	});

	test("retry parts do not reset the clock, even for family sessions", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteEvent(partEvent(PARENT, { id: "prt-retry", type: "retry", attempt: 3 }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);
	});

	test("tracks task children transitively and answers isFamily", () => {
		const guard = makeGuard();
		guard.noteEvent({
			type: "session.created",
			properties: { sessionID: CHILD, info: { id: CHILD, parentID: PARENT } },
		});
		expect(guard.isFamily(PARENT)).toBe(true);
		expect(guard.isFamily(CHILD)).toBe(true);
		expect(guard.isFamily("ses_other")).toBe(false);

		// A grandchild registers through the child.
		guard.noteEvent({
			type: "session.updated",
			properties: { sessionID: "ses_gc", info: { id: "ses_gc", parentID: CHILD } },
		});
		expect(guard.isFamily("ses_gc")).toBe(true);

		// Child content resets the clock.
		const before = guard.quietFor(Date.now() + 60_000);
		guard.noteEvent(partEvent(CHILD, { id: "prt3", type: "reasoning", text: "…" }));
		expect(guard.quietFor(Date.now())).toBeLessThan(before);
	});

	test("non-family content does not reset the clock", () => {
		const guard = makeGuard();
		const t0 = Date.now();
		guard.noteEvent(partEvent("ses_unrelated", { id: "prt4", type: "text", text: "x" }));
		expect(guard.quietFor(t0 + 60_000)).toBeGreaterThanOrEqual(59_000);
	});
});

describe("makeSubagentStallGuard.noteTool", () => {
	test("open task tools are tracked until completed or errored", () => {
		const guard = makeGuard();
		guard.noteTool({ id: "task1", tool: "task", state: { status: "running" } });
		guard.noteTool({ id: "bash1", tool: "bash", state: { status: "running" } });
		guard.noteTool({ id: "task1", tool: "task", state: { status: "completed" } });
		// No public accessor for openTasks; this at least exercises the state
		// transitions without throwing. The firing behavior is covered by the
		// noteEvent clock tests above plus the interval in start().
		expect(guard.isFamily(PARENT)).toBe(true);
	});
});
