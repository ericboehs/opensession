/**
 * Ordered, bounded feed for the live half of a session.
 *
 * Transcript entries already have a durable per-session sequence in
 * transcript-store. This feed gives ephemeral phases the same reconnect
 * semantics without making them durable.
 */

export type SessionFeedPhase = "delta" | "committed" | "status";

export interface SessionFeedFrame {
	type: "session_feed";
	sessionId: string;
	feedEpoch: string;
	feedSeq: number;
	runId?: string;
	turnId?: string;
	entryId?: string;
	phase: SessionFeedPhase;
	event: Record<string, unknown>;
}

export interface SessionFeedSnapshot {
	type: "feed_snapshot";
	sessionId: string;
	feedEpoch: string;
	feedSeq: number;
	active: null | {
		runId: string;
		turnId: string;
		entryId: string;
		by?: string;
		text: string;
		startedAt: number;
	};
}

interface FeedState {
	epoch: string;
	nextSeq: number;
	frames: SessionFeedFrame[];
	active: SessionFeedSnapshot["active"];
	landed: string[];
	bytes: number;
}

const MAX_FRAMES = 2_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 200;
const g = globalThis as {
	__osSessionFeeds?: Map<string, FeedState>;
};

function feeds(): Map<string, FeedState> {
	return (g.__osSessionFeeds ??= new Map());
}

function stateFor(sessionId: string): FeedState {
	let state = feeds().get(sessionId);
	if (state) {
		// Map insertion order doubles as a tiny LRU.
		feeds().delete(sessionId);
		feeds().set(sessionId, state);
	}
	if (!state) {
		state = {
			epoch: crypto.randomUUID(),
			nextSeq: 1,
			frames: [],
			active: null,
			landed: [],
			bytes: 0,
		};
		feeds().set(sessionId, state);
		while (feeds().size > MAX_SESSIONS) {
			const candidate = [...feeds()].find(
				([id, candidateState]) => id !== sessionId && !candidateState.active,
			);
			if (!candidate) break;
			feeds().delete(candidate[0]);
		}
	}
	return state;
}

function phaseFor(type: unknown): SessionFeedPhase {
	if (type === "transcript_append") return "committed";
	if (type === "stream_text") return "delta";
	return "status";
}

/** Append one event exactly once, then fan the returned immutable frame out. */
export function appendSessionFeed(
	sessionId: string,
	event: Record<string, unknown>,
): SessionFeedFrame {
	const state = stateFor(sessionId);
	const type = event.type;

	if (type === "stream_start") {
		const runId =
			typeof event.runId === "string" ? event.runId : crypto.randomUUID();
		const turnId =
			typeof event.turnId === "string" ? event.turnId : `turn:${runId}`;
		state.active = {
			runId,
			turnId,
			entryId: `stream:${runId}`,
			...(typeof event.by === "string" ? { by: event.by } : {}),
			text: "",
			startedAt: Date.now(),
		};
		state.landed = [];
	} else if (type === "stream_text" && state.active) {
		const text = typeof event.text === "string" ? event.text : "";
		const landedAt = state.landed.indexOf(text);
		if (landedAt === -1) state.active.text += text;
		else state.landed.splice(landedAt, 1);
	} else if (type === "transcript_append" && state.active) {
		const entries = Array.isArray(event.entries) ? event.entries : [];
		for (const entry of entries) {
			if (
				entry &&
				typeof entry === "object" &&
				(entry as { type?: unknown }).type === "assistant" &&
				typeof (entry as { content?: unknown }).content === "string"
			) {
				const content = (entry as { content: string }).content;
				const before = state.active.text;
				state.active.text = before.replace(content, "");
				if (before === state.active.text) state.landed.push(content);
			}
		}
		state.landed = state.landed.slice(-30);
	}

	const active = state.active;
	const frame: SessionFeedFrame = {
		type: "session_feed",
		sessionId,
		feedEpoch: state.epoch,
		feedSeq: state.nextSeq++,
		...(active
			? {
					runId: active.runId,
					turnId: active.turnId,
					entryId: active.entryId,
				}
			: {}),
		phase: phaseFor(type),
		event,
	};
	state.frames.push(frame);
	state.bytes += JSON.stringify(frame).length;
	while (
		state.frames.length > MAX_FRAMES ||
		(state.bytes > MAX_FEED_BYTES && state.frames.length > 1)
	) {
		const removed = state.frames.shift();
		if (removed) state.bytes -= JSON.stringify(removed).length;
	}
	if (type === "stream_done") {
		state.active = null;
		state.landed = [];
	}
	return frame;
}

export function sessionFeedSnapshot(sessionId: string): SessionFeedSnapshot {
	const state = stateFor(sessionId);
	return {
		type: "feed_snapshot",
		sessionId,
		feedEpoch: state.epoch,
		feedSeq: state.nextSeq - 1,
		active: state.active ? { ...state.active } : null,
	};
}

/**
 * Replay only a true gap. Epoch changes and cursors older than the bounded
 * window intentionally fall back to the active snapshot.
 */
export function resumeSessionFeed(
	sessionId: string,
	sinceFeedSeq?: number,
	feedEpoch?: string,
): { frames: SessionFeedFrame[]; snapshot: SessionFeedSnapshot } {
	const state = stateFor(sessionId);
	const snapshot = sessionFeedSnapshot(sessionId);
	if (
		feedEpoch !== state.epoch ||
		typeof sinceFeedSeq !== "number" ||
		!Number.isFinite(sinceFeedSeq)
	) {
		return { frames: [], snapshot };
	}
	const first = state.frames[0]?.feedSeq ?? state.nextSeq;
	if (sinceFeedSeq < first - 1 || sinceFeedSeq > state.nextSeq - 1) {
		return { frames: [], snapshot };
	}
	if (!state.active) return { frames: [], snapshot };
	return {
		frames: state.frames.filter(
			(frame) =>
				frame.feedSeq > sinceFeedSeq &&
				(frame.runId === state.active?.runId ||
					(frame.phase === "committed" && !frame.runId)),
		),
		// A valid cursor replays deltas; sending cumulative active text as well
		// would duplicate that gap on the client.
		snapshot: { ...snapshot, active: null },
	};
}

export function isFeedEvent(msg: object): boolean {
	const type = (msg as { type?: string }).type;
	return (
		type === "stream_start" ||
		type === "stream_text" ||
		type === "stream_tool_use" ||
		type === "stream_tool_result" ||
		type === "stream_done" ||
		type === "session_status"
	);
}
