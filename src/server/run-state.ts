/**
 * Explicit per-session run-state machine: one answer to "what state is this
 * session's run in?", with every transition (and every REJECTED transition)
 * audited.
 *
 * Why: today that answer is derived from ~18 scattered markers in three
 * storage tiers, and there are four independent "is it running?" derivations —
 * `isAgentSessionBusy` (OR of pendingStarts + activeOpencodeRuns + hostRuns),
 * the run journal (`ActiveRunRecord`), the recomputed `isRunning`/
 * `runStartedAt` on UnifiedSession, and `getRunningPids()` for external CLI
 * runs. They key on different ids and nothing ties them together, so they can
 * disagree — and each disagreement is a known incident class: zombie busy
 * (busy-map entry, no journal record), inverse zombie (journal record, no
 * driver), steer receipts with no run to fold into, drains firing against
 * externally-owned runs. This module doesn't replace those stores (yet); it
 * runs alongside them as the explicit source of truth, so an illegal
 * combination becomes a loud `run_state_rejected` audit event instead of a
 * silent wedge diagnosed from memory recipes.
 *
 * How the implicit markers map onto states:
 *   preparing    preparingWorkspaces (ws-hub.ts)
 *   starting     pendingStarts (agent-runner.ts markSessionStarting)
 *   running      activeOpencodeRuns / detachedRunKeys / hostRuns
 *   ask_blocked  running + pendingAsks (asks.ts)
 *   stopped      stoppedSessions latch (queue-state.ts)
 *   failed       runErrors / lastRunError (session-cache.ts recordRunOutcome)
 *   interrupted  journal ActiveRunRecord with no live driver (run-journal.ts)
 *   reattaching  tryReattachOpencodeRun in flight (opencode-runner.ts)
 *   idle         none of the above
 * Orthogonal context, deliberately NOT states: queued prompts / steer receipts
 * (delivery obligations), manualStatus (human display pin), detached-vs-child
 * (a `running` attribute that only matters at shutdown).
 *
 * Wiring plan (follow-up — call sites live in files other sessions are
 * mid-edit on; this module ships with zero call sites so it can land without
 * touching them, and transitions are additive observation, not control flow):
 *   prompt / start_aborted   run-session.ts runSessionPrompt (markSessionStarting
 *                            + stop-latch clear, ~:1084)
 *   run_registered/turn_end/run_failed/engine_died
 *                            opencode-runner.ts run start + finally;
 *                            host-registry.ts register/unregisterHostRun
 *   ask_posed / ask_resolved asks.ts makeAskHandler / resolve
 *   cancel                   the Stop path that sets stoppedSessions +
 *                            requeueSteerReceipts callers
 *   boot_journal_found, reattach_start/ok/fail, resume_reprompt
 *                            run-journal.ts takeInterruptedRuns, opencode-
 *                            runner.ts tryReattachOpencodeRun, agent-runner.ts
 *                            continuation fallback
 *   shutdown_orphaned        run-session.ts snapshotActiveSessions
 * Everything listed is runner-internal: wiring needs a real restart to apply.
 *
 * State lives in-memory on globalThis (hot-reload safe, restart-fresh — a
 * restart re-derives reality through the boot events, so persisting this map
 * would only let it go stale).
 */

import { audit } from "./audit";

export type RunState =
	| "idle"
	| "preparing"
	| "starting"
	| "running"
	| "ask_blocked"
	| "stopped"
	| "failed"
	| "interrupted"
	| "reattaching";

export type RunEvent =
	| "prompt"
	| "workspace_prepare"
	| "workspace_ready"
	| "workspace_failed"
	| "run_registered"
	| "start_failed"
	| "start_aborted"
	| "ask_posed"
	| "ask_resolved"
	| "steer"
	| "turn_end"
	| "run_failed"
	| "cancel"
	| "engine_died"
	| "shutdown_orphaned"
	| "boot_journal_found"
	| "reattach_start"
	| "reattach_ok"
	| "reattach_fail"
	| "resume_reprompt";

/**
 * The full transition table. Absence of an edge is load-bearing: an event
 * arriving in a state with no edge for it is exactly the illegal combination
 * this module exists to surface (e.g. `turn_end` while `idle` = a double
 * teardown; `ask_resolved` while `running` = an answer for an ask nobody's
 * waiting on).
 *
 * Deliberate leniency edges, so half-wired paths degrade to logging instead of
 * false alarms: `run_registered` straight from idle/stopped/failed (a run
 * path whose reserve step isn't instrumented yet — e.g. the Slack/Linear
 * loops), and self-edges for queue-while-busy (`prompt`), mid-run `steer`,
 * and rotation re-registration (`run_registered` while running).
 */
export const RUN_STATE_TRANSITIONS: Record<
	RunState,
	Partial<Record<RunEvent, RunState>>
> = {
	idle: {
		prompt: "starting",
		workspace_prepare: "preparing",
		boot_journal_found: "interrupted",
		run_registered: "running",
	},
	preparing: {
		workspace_ready: "idle",
		workspace_failed: "failed",
		cancel: "idle",
	},
	starting: {
		run_registered: "running",
		start_failed: "failed",
		start_aborted: "idle",
		run_failed: "failed",
		cancel: "stopped",
		prompt: "starting",
	},
	running: {
		ask_posed: "ask_blocked",
		turn_end: "idle",
		run_failed: "failed",
		cancel: "stopped",
		engine_died: "interrupted",
		shutdown_orphaned: "interrupted",
		prompt: "running",
		steer: "running",
		run_registered: "running",
	},
	ask_blocked: {
		ask_resolved: "running",
		turn_end: "idle",
		run_failed: "failed",
		cancel: "stopped",
		engine_died: "interrupted",
		shutdown_orphaned: "interrupted",
		prompt: "ask_blocked",
		steer: "ask_blocked",
	},
	stopped: {
		prompt: "starting",
		run_registered: "running",
	},
	failed: {
		prompt: "starting",
		run_registered: "running",
	},
	interrupted: {
		reattach_start: "reattaching",
		resume_reprompt: "starting",
		cancel: "idle",
		engine_died: "interrupted",
		boot_journal_found: "interrupted",
	},
	reattaching: {
		reattach_ok: "running",
		reattach_fail: "interrupted",
		run_failed: "failed",
		cancel: "stopped",
		engine_died: "interrupted",
	},
};

/** Pure lookup: the next state, or undefined when no edge exists. */
export function nextRunState(
	state: RunState,
	event: RunEvent,
): RunState | undefined {
	return RUN_STATE_TRANSITIONS[state]?.[event];
}

export type RunStateEntry = {
	state: RunState;
	since: string;
	lastEvent?: RunEvent;
};

const g = globalThis as any;
export const runStates: Map<string, RunStateEntry> = (g.__runStates ??=
	new Map());

export function getRunState(sessionId: string): RunState {
	return runStates.get(sessionId)?.state ?? "idle";
}

type AuditEmit = (event: Record<string, unknown>) => void;

/**
 * Apply an event to a session's run state. A defined edge moves the state and
 * emits `run_state_transition`; an undefined one leaves the state untouched
 * and emits `run_state_rejected` + a console.warn — rejected transitions are
 * the whole point, never swallow them. Returns the (possibly unchanged)
 * resulting state.
 */
export function transitionRunState(
	sessionId: string,
	event: RunEvent,
	detail?: Record<string, unknown>,
	emit: AuditEmit = audit,
): RunState {
	const from = getRunState(sessionId);
	const to = nextRunState(from, event);
	if (to === undefined) {
		console.warn(
			`[run-state] rejected: ${event} while ${from} (session ${sessionId})`,
		);
		emit({
			msg: "run_state_rejected",
			bks_session_id: sessionId,
			state: from,
			event,
			...detail,
		});
		return from;
	}
	runStates.set(sessionId, {
		state: to,
		since: new Date().toISOString(),
		lastEvent: event,
	});
	emit({
		msg: "run_state_transition",
		bks_session_id: sessionId,
		from,
		to,
		event,
		...detail,
	});
	return to;
}

/**
 * Recovery escape hatch for paths that reconcile against external reality
 * (e.g. boot discovering a run the table didn't predict). Always audited with
 * the caller's reason; never use it where a normal event fits.
 */
export function forceRunState(
	sessionId: string,
	state: RunState,
	reason: string,
	emit: AuditEmit = audit,
): void {
	const from = getRunState(sessionId);
	runStates.set(sessionId, { state, since: new Date().toISOString() });
	emit({
		msg: "run_state_forced",
		bks_session_id: sessionId,
		from,
		to: state,
		reason,
	});
}

/** Drop tracking for a deleted session. */
export function clearRunState(sessionId: string): void {
	runStates.delete(sessionId);
}
