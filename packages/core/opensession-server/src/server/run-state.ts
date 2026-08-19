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
 * Wiring (transitions are additive observation; the busy gate also treats
 * unsettled states as session ownership). Everything keys on the bks session id:
 *   prompt                   agent-runner.ts markSessionStarting (called by
 *                            every run path before its first await)
 *   run_registered           run-journal.ts journalSet (run start + fallback
 *                            re-journal; self-edge while running)
 *   turn_end / run_failed    session-cache.ts recordRunOutcome (the one
 *                            terminal-outcome choke point for owned runs)
 *   ask_posed / ask_resolved asks.ts makeAskHandler (offerAskCard is exempt —
 *                            its card doesn't park the run)
 *   cancel                   ws-handlers.ts "cancel" (the UI Stop button) +
 *                            routes/sessions.ts archive-stop
 *   boot_journal_found       run-journal.ts takeInterruptedRuns
 *   reattach_start/ok/fail, resume_reprompt
 *                            agent-runner.ts resumeInterruptedRuns
 * Not wired yet: engine_died / shutdown_orphaned (opencode-runner.ts /
 * run-session.ts), workspace_prepare/ready (ws-hub.ts), mid-run steer. The
 * leniency edges below keep those gaps silent instead of noisy.
 * Runner-internal wiring needs a real restart; so do WS-handler edits
 * (they keep serving old code under --hot despite what the docs suggest).
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
 * false alarms: `run_registered` straight from idle/stopped/failed/interrupted/
 * reattaching (a run path whose reserve/recovery marker isn't instrumented —
 * e.g. the Slack/Linear loops, or a domain-specific boot recovery); self-edges
 * for queue-while-busy (`prompt`), mid-run `steer`, rotation re-registration
 * (`run_registered` while running), and ask-overwrite (`ask_posed` while
 * ask_blocked); and `stopped` absorbing the cancelled run's own teardown
 * (`turn_end`/`run_failed` land after the Stop that caused them).
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
		ask_posed: "ask_blocked",
	},
	stopped: {
		prompt: "starting",
		run_registered: "running",
		turn_end: "stopped",
		run_failed: "stopped",
		cancel: "stopped",
	},
	failed: {
		prompt: "starting",
		run_registered: "running",
	},
	interrupted: {
		reattach_start: "reattaching",
		resume_reprompt: "starting",
		cancel: "stopped",
		engine_died: "interrupted",
		boot_journal_found: "interrupted",
		run_registered: "running",
		// An engine death mid-run fires engine_died → interrupted at the
		// watcher, then the run's own terminal outcome (recordRunOutcome)
		// lands moments later. A dead-server turn is lost, not resumable —
		// the follow-up outcome settles it as failed/idle rather than
		// rejecting.
		run_failed: "failed",
		turn_end: "idle",
	},
	reattaching: {
		reattach_ok: "running",
		reattach_fail: "interrupted",
		run_failed: "failed",
		cancel: "stopped",
		engine_died: "interrupted",
		run_registered: "running",
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

/** States that still own the session and must settle before a new turn starts. */
export function isRunStateUnsettled(state: RunState): boolean {
	return (
		state === "preparing" ||
		state === "starting" ||
		state === "running" ||
		state === "ask_blocked" ||
		state === "interrupted" ||
		state === "reattaching"
	);
}

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
			session_id: sessionId,
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
		session_id: sessionId,
		from,
		to,
		event,
		...detail,
	});
	return to;
}

/** Drop tracking for a deleted session. */
export function clearRunState(sessionId: string): void {
	runStates.delete(sessionId);
}
