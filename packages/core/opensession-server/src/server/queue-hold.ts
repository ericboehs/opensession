/**
 * Pure queue-batch selection for run-session's drain loop, split out so the
 * "queued messages deliver only when the agent FULLY completes" promise is
 * unit-testable. The drain calls this once per pass with the live queue and
 * the session's continuation state; it never mutates the input.
 */
import { AUTO_CONTINUE_USER } from "./auto-continue";
import type { QueueItem } from "./queue-state";

export type QueueBatchPlan =
	| { kind: "deliver"; batch: QueueItem[]; rest: QueueItem[] }
	| { kind: "hold"; heldCount: number };

export function selectQueueBatch(
	queue: QueueItem[],
	opts: {
		/** Interrupt targeted one specific item (queue chip ▲): deliver only it. */
		soloId?: string;
		/** The queue head was armed by aborting the running turn (Esc+Enter):
		 *  the user asked for delivery NOW — the hold never applies. */
		interruptMark?: boolean;
		/** The session is still logically working past its own turn end
		 *  (running child worker sessions): hold human composer sends. */
		stillWorking?: boolean;
	},
): QueueBatchPlan {
	const soloIndex = opts.soloId
		? queue.findIndex((m) => m.id === opts.soloId)
		: -1;
	if (soloIndex >= 0) {
		return {
			kind: "deliver",
			batch: [queue[soloIndex]],
			rest: queue.filter((_, i) => i !== soloIndex),
		};
	}
	// An auto-continue at the head delivers alone: it exists to let the agent
	// FINISH its announced work while queued messages stay parked behind it —
	// batching them in would deliver them mid-task, the exact thing queueing
	// promises not to do.
	if (queue[0]?.user === AUTO_CONTINUE_USER) {
		return { kind: "deliver", batch: [queue[0]], rest: queue.slice(1) };
	}
	// A review handoff is an automation phase boundary. Anything ahead of it is
	// an earlier human request and gets its own turn first; the handoff then
	// drains alone, preserving both transcript order and the reviewed SHA's
	// meaning instead of folding feedback into unrelated work.
	const handoffAt = queue.findIndex((m) => m.reviewHandoff);
	if (handoffAt === 0)
		return { kind: "deliver", batch: [queue[0]], rest: queue.slice(1) };
	if (handoffAt > 0)
		return { kind: "deliver", batch: queue.slice(0, handoffAt), rest: queue.slice(handoffAt) };
	if (opts.stillWorking && !opts.interruptMark) {
		const batch = queue.filter((m) => !m.hold);
		if (batch.length === 0) return { kind: "hold", heldCount: queue.length };
		return { kind: "deliver", batch, rest: queue.filter((m) => m.hold) };
	}
	return { kind: "deliver", batch: [...queue], rest: [] };
}
