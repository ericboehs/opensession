/**
 * Read tracking for session team notes (the transcript NoteBubbles). Parallel
 * to lib/reads.ts but keyed on the note channel's last message timestamp:
 * SessionViewer stamps `opensession-note-read:<id>` while a session is open;
 * a session dots as unread when its channel has a newer note from someone
 * else. A one-time baseline stamp keeps pre-feature chat history (the old
 * Chat tab wrote the same channels) from lighting every row on rollout.
 */

const BASELINE_KEY = "opensession-note-baseline";
const READ_PREFIX = "opensession-note-read:";
const CHANGE_EVENT = "opensession-note-read-changed";

function baseline(): number {
	let v = Number(localStorage.getItem(BASELINE_KEY) || 0);
	if (!v) {
		v = Date.now();
		localStorage.setItem(BASELINE_KEY, String(v));
	}
	return v;
}

export function isNoteUnread(
	sessionId: string,
	lastTs: number,
	lastUser: string,
	me: string,
): boolean {
	if (!lastTs || lastUser === me) return false;
	const stamp = Number(localStorage.getItem(READ_PREFIX + sessionId) || 0);
	return lastTs > Math.max(stamp, baseline());
}

export function onNoteReadsChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	window.addEventListener("storage", handler);
	return () => {
		window.removeEventListener(CHANGE_EVENT, handler);
		window.removeEventListener("storage", handler);
	};
}
