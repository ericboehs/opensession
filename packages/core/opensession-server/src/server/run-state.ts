/**
 * Authoritative per-session run-state machine.
 *
 * The transition table remains pure and exhaustively tested. Runtime state is
 * committed by SessionKernel, which gives prompt admission, recovery, asks,
 * cancellation and executor events one durable answer to whether the session
 * is owned. Detached run hosts keep only a private ephemeral view: they report
 * events to the server and never write the session kernel database.
 */

import { audit } from "./audit";
import { clearSessionKernel, sessionKernel, sessionKernelStore } from "./session-kernel";

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
		boot_journal_found: "interrupted",
		workspace_ready: "idle",
		workspace_failed: "failed",
		cancel: "idle",
	},
	starting: {
		boot_journal_found: "interrupted",
		run_registered: "running",
		start_failed: "failed",
		start_aborted: "idle",
		run_failed: "failed",
		cancel: "stopped",
		prompt: "starting",
	},
	running: {
		boot_journal_found: "interrupted",
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
		boot_journal_found: "interrupted",
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
		boot_journal_found: "interrupted",
		prompt: "starting",
		run_registered: "running",
		turn_end: "stopped",
		run_failed: "stopped",
		cancel: "stopped",
	},
	failed: {
		boot_journal_found: "interrupted",
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
		boot_journal_found: "interrupted",
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

const detachedHostStates = new Map<string, RunStateEntry>();
const detachedRunHost = () => !!process.env.OPENSESSION_RUN_JOURNAL;

export const runStates = {
	get(sessionId: string): RunStateEntry | undefined {
		if (detachedRunHost()) return detachedHostStates.get(sessionId);
		const current = sessionKernelStore().runState(sessionId);
		if (current.changeSeq === 0) return undefined;
		return {
			state: current.state as RunState,
			since: current.since,
			lastEvent: current.lastEvent as RunEvent | undefined,
		};
	},
};

export function getRunState(sessionId: string): RunState {
	if (detachedRunHost()) return detachedHostStates.get(sessionId)?.state ?? "idle";
	return sessionKernelStore().runState(sessionId).state as RunState;
}

type AuditEmit = (event: Record<string, unknown>) => void;

/**
 * Apply an event through the owning SessionKernel. A defined edge moves the
 * durable state and emits `run_state_transition`; an undefined one leaves the
 * state untouched and emits `run_state_rejected`.
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
	const runKey = typeof detail?.run_key === "string" ? detail.run_key : undefined;
	if (!detachedRunHost() && event === "run_registered" && runKey) {
		const owner = sessionKernel(sessionId).runState();
		if (
			owner.currentRunId &&
			owner.currentRunId !== runKey &&
			(from === "running" ||
				from === "ask_blocked" ||
				from === "interrupted" ||
				from === "reattaching")
		) {
			emit({
				msg: "stale_run_registration_rejected",
				session_id: sessionId,
				current_run_id: owner.currentRunId,
				rejected_run_id: runKey,
				state: from,
			});
			return from;
		}
	}
	if (detachedRunHost()) {
		detachedHostStates.set(sessionId, {
			state: to,
			since: new Date().toISOString(),
			lastEvent: event,
		});
	} else {
	const kernel = sessionKernel(sessionId);
	if (runKey && (event === "run_registered" || event === "boot_journal_found"))
		kernel.registerRun(runKey, to, event, detail);
	else kernel.setRunState({ state: to, event, detail });
	}
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
	if (detachedRunHost()) detachedHostStates.delete(sessionId);
	else clearSessionKernel(sessionId);
}
