/**
 * Which optimistic "just sent" bubbles the server has accounted for.
 *
 * A bubble is CLAIMED when its message shows up for real: a queued entry or a
 * steer receipt echoed back, or a transcript user entry recorded around or
 * after the send. A bubble nothing claims within PENDING_GIVE_UP_MS is EXPIRED
 * instead, which is a weaker statement: the prompt may still be in flight, so a
 * caller may hide the bubble but must not treat the message as delivered.
 */

/** How far before a bubble's own send a transcript entry may be recorded and
 *  still claim it. Clocks differ between this tab and the server. */
export const PENDING_MATCH_WINDOW_MS = 30_000;
/** After this long with nothing claiming it, stop showing a bubble so a dead
 *  send never sticks as "sending…". */
export const PENDING_GIVE_UP_MS = 120_000;

export interface PendingPrompt {
	id: string;
	content: string;
	user?: string;
	sentAt: number;
	/** The delivery response says this prompt started a turn. A transient queue
	 *  receipt must not retire its transcript bubble before the real entry lands. */
	serverStarted?: true;
}

export interface OptimisticPendingPrompt extends PendingPrompt {
	images?: string[];
	busyMode?: "queue" | "steer";
}

/**
 * The composer places a new optimistic prompt from its last-known running
 * state. The server can make the opposite decision in the send race: a run
 * that looked busy may finish before intake, so the authoritative result is
 * `started`. Move that prompt back to the transcript surface. If a transient
 * queue echo already claimed and removed it, restore the bubble until its real
 * transcript entry arrives.
 */
export function markPendingStarted(
	pending: OptimisticPendingPrompt[],
	started: OptimisticPendingPrompt,
): OptimisticPendingPrompt[] {
	const index = pending.findIndex((item) => item.id === started.id);
	if (index < 0) return [...pending, { ...started, serverStarted: true }];
	if (pending[index].serverStarted && !pending[index].busyMode) return pending;
	const next = pending.slice();
	const transcriptBubble = { ...pending[index], serverStarted: true as const };
	delete transcriptBubble.busyMode;
	next[index] = transcriptBubble;
	return next;
}

export interface ReconcileResult {
	/** Confirmed by the server. Safe to retire every optimistic record of it. */
	landed: Set<string>;
	/** Unclaimed for too long. Hide only — the send may still be in flight. */
	expired: Set<string>;
}

export function reconcilePending(
	pending: readonly PendingPrompt[],
	entries: readonly { type: string; content: string; timestamp: string }[],
	echoes: readonly { content: string }[],
	now: number,
): ReconcileResult {
	const landed = new Set<string>();
	const expired = new Set<string>();
	if (pending.length === 0) return { landed, expired };
	const userPool = entries
		.filter((e) => e.type === "user")
		.map((e) => ({
			c: e.content.trim(),
			t: new Date(e.timestamp).getTime(),
		}));
	// A just-sent message is confirmed by a queued echo, a steer receipt
	// (busy/fold-in path), or a real transcript user entry.
	const echoPool = echoes.map((q) => q.content.trim());
	for (const p of pending) {
		const c = p.content.trim();
		// An idle send is briefly queue-owned while the server dispatches it. The
		// queue_update can arrive before the HTTP `started` response and its empty
		// successor can arrive before the transcript watcher echoes the user row.
		// Once the response confirms `started`, only that transcript row may retire
		// the bubble; otherwise the running dot appears beside a blank conversation.
		if (!p.serverStarted) {
			const qi = echoPool.indexOf(c);
			if (qi >= 0) {
				echoPool.splice(qi, 1);
				landed.add(p.id);
				continue;
			}
		}
		// Interrupt/steer-path sends land in the transcript with a "[user] "
		// attribution prefix (added server-side), while the optimistic bubble
		// holds the raw text — accept either form so a redirected message's
		// bubble reconciles instead of sticking as "redirecting…".
		const attributed = p.user ? `[${p.user}] ${c}` : c;
		const ui = userPool.findIndex(
			(u) =>
				(u.c === c || u.c === attributed) &&
				u.t >= p.sentAt - PENDING_MATCH_WINDOW_MS,
		);
		if (ui >= 0) {
			userPool.splice(ui, 1);
			landed.add(p.id);
			continue;
		}
		// Steers pending at the same turn boundary get joined into ONE user
		// turn ("\n\n"-separated, each with its attribution prefix), possibly
		// alongside a harness nudge — so the exact match above never fires.
		// The "[user] " prefix is distinctive enough to claim by containment.
		// Don't splice: the same joined entry may cover other bubbles too.
		if (
			p.user &&
			userPool.some(
				(u) =>
					u.c.includes(attributed) &&
					u.t >= p.sentAt - PENDING_MATCH_WINDOW_MS,
			)
		) {
			landed.add(p.id);
			continue;
		}
		if (now - p.sentAt >= PENDING_GIVE_UP_MS) expired.add(p.id);
	}
	return { landed, expired };
}
