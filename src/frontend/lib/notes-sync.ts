/**
 * A tiny Yjs network provider that rides Backstage's existing multiplexed
 * WebSocket (the same socket sessions use) instead of a dedicated y-websocket
 * server. Binary Yjs document updates and awareness (cursor) updates are
 * base64-encoded inside the JSON envelope the socket already speaks.
 *
 * Mirrors the server side in backstage.ts (noteWatchers + watch_note /
 * note_update / note_awareness). Pass it the `send`/`addHandler` from
 * useWebSocket. Call `destroy()` on unmount.
 */
import * as Y from "yjs";
import {
	Awareness,
	encodeAwarenessUpdate,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import type { WSClientMessage, WSServerMessage } from "./types";

// Updates we applied from the network carry this origin so we don't echo them
// straight back out (which would loop forever).
const REMOTE = Symbol("note-remote");

function u8ToB64(u: Uint8Array): string {
	let s = "";
	for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
	return btoa(s);
}
function b64ToU8(b: string): Uint8Array {
	const s = atob(b);
	const u = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
	return u;
}

/** Deterministic cursor color per user name. */
function colorFor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
	const hue = Math.abs(h) % 360;
	return `hsl(${hue} 70% 60%)`;
}

export interface NoteSync {
	doc: Y.Doc;
	ytext: Y.Text;
	awareness: Awareness;
	destroy: () => void;
}

export function createNoteSync(opts: {
	noteId: string;
	user: string;
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
}): NoteSync {
	const { noteId, user, send } = opts;
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	const awareness = new Awareness(doc);
	awareness.setLocalStateField("user", {
		name: user || "Anonymous",
		color: colorFor(user || "Anonymous"),
		colorLight: colorFor(user || "Anonymous"),
	});

	// Outbound: local doc edits → relay (skip updates we just applied from remote).
	const onDocUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE) return;
		send({ type: "note_update", noteId, update: u8ToB64(update) });
	};
	doc.on("update", onDocUpdate);

	// Outbound: local cursor/selection changes → relay.
	const onAwareness = (
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin === REMOTE) return;
		const changed = added.concat(updated, removed);
		send({
			type: "note_awareness",
			noteId,
			update: u8ToB64(encodeAwarenessUpdate(awareness, changed)),
		});
	};
	awareness.on("update", onAwareness);

	// Inbound: apply server/peer messages for this note.
	const removeHandler = opts.addHandler((msg) => {
		if (!("noteId" in msg) || msg.noteId !== noteId) return;
		if (msg.type === "note_state" || msg.type === "note_update") {
			Y.applyUpdate(doc, b64ToU8(msg.update), REMOTE);
		} else if (msg.type === "note_awareness") {
			applyAwarenessUpdate(awareness, b64ToU8(msg.update), REMOTE);
		}
	});

	// NB: the `watch_note` join is sent by NoteEditor once the socket is open (and
	// re-sent on reconnect) — sending it here would race a still-connecting socket
	// and be silently dropped, so the client would never actually join the room.

	function destroy() {
		removeHandler();
		doc.off("update", onDocUpdate);
		awareness.off("update", onAwareness);
		// Tell peers our cursor is gone, then leave the room.
		removeAwarenessStates(awareness, [doc.clientID], "destroy");
		send({ type: "leave_note" });
		awareness.destroy();
		doc.destroy();
	}

	return { doc, ytext, awareness, destroy };
}
