import { useEffect, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { notifyEvent } from "../lib/notify";

// Watches the polled session list and alerts (sound + desktop banner, per the
// user's notification settings) each time one of *your* sessions newly:
//   • transitions into "needs input" (blocked on an AskUserQuestion), or
//   • finishes a run (was running, now idle and not waiting).
// Only transitions alert — a session already in that state when the tab opens, or
// one that stays there across polls, does not re-fire. Which of the two events
// actually notifies is decided inside notifyEvent from the persisted settings.
export function useInputAlerts(
	sessions: UnifiedSession[],
	opts: {
		isMine: (s: UnifiedSession) => boolean;
		onOpen: (id: string) => void;
	},
): void {
	// null until the first snapshot — used to seed the baseline without alerting on
	// sessions that were already in-state before this tab opened.
	const waitingRef = useRef<Set<string> | null>(null);
	const runningRef = useRef<Set<string> | null>(null);
	const isMineRef = useRef(opts.isMine);
	const onOpenRef = useRef(opts.onOpen);
	isMineRef.current = opts.isMine;
	onOpenRef.current = opts.onOpen;

	useEffect(() => {
		const mine = sessions.filter((s) => isMineRef.current(s));

		const waiting = mine.filter((s) => s.waitingForInput);
		const waitingIds = new Set(waiting.map((s) => s.id));
		const running = mine.filter((s) => s.isRunning);
		const runningIds = new Set(running.map((s) => s.id));

		// Seed baselines on the first snapshot without firing.
		if (waitingRef.current === null || runningRef.current === null) {
			waitingRef.current = waitingIds;
			runningRef.current = runningIds;
			return;
		}

		const prevWaiting = waitingRef.current;
		const prevRunning = runningRef.current;
		waitingRef.current = waitingIds;
		runningRef.current = runningIds;

		// Newly waiting for input.
		for (const s of waiting) {
			if (prevWaiting.has(s.id)) continue;
			notifyEvent(
				"needsInput",
				"Needs input",
				s.title || "A session is waiting for your answer",
				() => onOpenRef.current(s.id),
			);
		}

		// Newly finished: was running, now not running and not waiting on a question.
		for (const s of mine) {
			if (!prevRunning.has(s.id)) continue;
			if (s.isRunning || s.waitingForInput) continue;
			notifyEvent(
				"done",
				"Finished",
				s.title || "A session finished working",
				() => onOpenRef.current(s.id),
			);
		}
	}, [sessions]);
}
