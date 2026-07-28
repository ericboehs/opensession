/**
 * Native Backstage team chat — nothing to do with Slack. Two kinds of rooms
 * share one implementation, keyed by channel id:
 *
 *   - "watercooler"      the team-wide room (left-sidebar entry)
 *   - "session:<id>"     a per-session room (the session panel's Chat tab)
 *
 * Messages persist per channel in `~/.opensession-chat/<channel>.json` (the
 * flat-file pattern of pins.ts/push.ts); realtime delivery and typing
 * indicators ride the app WebSocket (wired in backstage.ts). An `@Name`
 * mention web-pushes the tagged teammate's devices via src/server/push.ts.
 * `@session:<id>` tokens tag a session — rendered as a clickable chip by the
 * frontend, ignored by mention pushes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";
import { teamFirstNames } from "./people";

const CHAT_DIR = stateDir("chat");
// Attached images live here permanently (unlike the transient session-upload
// staging dir), served back by id via GET /backstage/api/chat/image/:id.
const CHAT_IMG_DIR = `${CHAT_DIR}/images`;

// Keep each channel's store bounded — the UI only ever loads the recent tail.
const MAX_STORED = 5000;
const MAX_TEXT_LEN = 8000;
const MAX_IMAGES_PER_MSG = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** An image attached to a chat message. Stored on disk by `id`; the bytes never
 *  ride the message JSON (kept small) — the client fetches them by id. */
export interface ChatImage {
	id: string;
	/** Original filename, for alt text / download. */
	name: string;
	/** MIME type, used as the Content-Type when serving the bytes back. */
	mime: string;
}

/** Snapshot of a quoted message (Slack-style "reply"). A copy, not a
 *  reference — it stays renderable even after the original leaves the
 *  bounded store. */
export interface ChatReplyTo {
	id: string;
	user: string;
	/** Excerpt of the original text (bounded; may be empty for image-only). */
	text: string;
}

export interface ChatMessage {
	id: string;
	/** Sender's self-selected display name. */
	user: string;
	text: string;
	/** Attached images (may be empty/absent). */
	images?: ChatImage[];
	/** ms epoch */
	ts: number;
	/** Thread parent's message id — set only on thread replies. Replies to a
	 *  reply are re-rooted onto the top-level parent (threads never nest). */
	threadId?: string;
	/** Quoted message this one replies to (independent of threads). */
	replyTo?: ChatReplyTo;
	/** emoji → display names of teammates who reacted with it. */
	reactions?: Record<string, string[]>;
}

// Raster types only — SVG is deliberately excluded: it can carry scripts and
// serving it from our own origin (via the image link) would be an XSS vector.
const IMAGE_MIME_EXT: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
	"image/avif": true,
};

/** Persist uploaded image bytes and return its reference. Throws on a
 *  non-image MIME or oversized payload — the caller surfaces the error. */
export function saveChatImage(
	bytes: Uint8Array,
	name: string,
	mime: string,
): ChatImage {
	if (!IMAGE_MIME_EXT[mime]) throw new Error(`Unsupported image type: ${mime}`);
	if (bytes.byteLength > MAX_IMAGE_BYTES)
		throw new Error(
			`Image too large (max ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB)`,
		);
	if (!existsSync(CHAT_IMG_DIR)) mkdirSync(CHAT_IMG_DIR, { recursive: true });
	const id = crypto.randomUUID();
	writeFileSync(`${CHAT_IMG_DIR}/${id}`, bytes);
	// Sidecar so the serving route can set an accurate Content-Type from the
	// validated MIME rather than sniffing or trusting a query param.
	writeFileSync(`${CHAT_IMG_DIR}/${id}.type`, mime);
	return { id, name: name.trim().slice(0, 200) || "image", mime };
}

/** Resolve a stored image's path + MIME by id (ids are uuids from
 *  `saveChatImage`; reject anything that isn't so path traversal is impossible). */
export function getChatImage(id: string): { path: string; mime: string } | null {
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	const path = `${CHAT_IMG_DIR}/${id}`;
	if (!existsSync(path)) return null;
	let mime = "application/octet-stream";
	try {
		const t = readFileSync(`${path}.type`, "utf8").trim();
		if (IMAGE_MIME_EXT[t]) mime = t;
	} catch {}
	return { path, mime };
}

/** Validate + normalize a client-supplied image list against what's on disk. */
function sanitizeImages(raw: unknown): ChatImage[] {
	if (!Array.isArray(raw)) return [];
	const out: ChatImage[] = [];
	for (const img of raw.slice(0, MAX_IMAGES_PER_MSG)) {
		if (!img || typeof img !== "object") continue;
		const id = typeof (img as any).id === "string" ? (img as any).id : "";
		const name = typeof (img as any).name === "string" ? (img as any).name : "";
		const mime = typeof (img as any).mime === "string" ? (img as any).mime : "";
		if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
		if (!IMAGE_MIME_EXT[mime]) continue;
		// Only keep refs whose bytes actually landed on disk.
		if (!existsSync(`${CHAT_IMG_DIR}/${id}`)) continue;
		out.push({ id, name: name.slice(0, 200) || "image", mime });
	}
	return out;
}

/** Validate + bound a client-supplied quote snapshot. */
function sanitizeReplyTo(raw: unknown): ChatReplyTo | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const id = typeof (raw as any).id === "string" ? (raw as any).id : "";
	const user = typeof (raw as any).user === "string" ? (raw as any).user : "";
	const text = typeof (raw as any).text === "string" ? (raw as any).text : "";
	if (!/^[0-9a-f-]{36}$/i.test(id) || !user.trim()) return undefined;
	return {
		id,
		user: user.trim().slice(0, 64),
		text: text.trim().slice(0, 300),
	};
}

// Mentionable teammates — derived from the identity config (same roster the
// frontend fetches via GET /api/people). These picker first names are also the
// keys push subscriptions are stored under (push.ts matches exact names).
const CHAT_TEAM = teamFirstNames();

/** "watercooler" or "session:<session id>" — anything else is rejected. */
export function isValidChatChannel(channel: unknown): channel is string {
	return (
		typeof channel === "string" &&
		(channel === "watercooler" || /^session:[A-Za-z0-9._-]{1,80}$/.test(channel))
	);
}

function fileFor(channel: string): string {
	// Channel ids are validated, but keep the filename mapping defensive.
	const safe = channel.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
	return `${CHAT_DIR}/${safe}.json`;
}

function readAll(channel: string): ChatMessage[] {
	try {
		const f = fileFor(channel);
		if (!existsSync(f)) return [];
		const raw = JSON.parse(readFileSync(f, "utf8"));
		if (!Array.isArray(raw?.messages)) return [];
		return raw.messages.filter(
			(m: unknown): m is ChatMessage =>
				!!m &&
				typeof (m as any).id === "string" &&
				typeof (m as any).user === "string" &&
				typeof (m as any).text === "string" &&
				typeof (m as any).ts === "number",
		);
		// Older records predate `images`; the field is optional so they load fine.
	} catch {
		return [];
	}
}

/** The channel's most recent `limit` messages, oldest first. */
export function getChatMessages(channel: string, limit = 200): ChatMessage[] {
	const capped = Math.max(1, Math.min(limit, MAX_STORED));
	return readAll(channel).slice(-capped);
}

/**
 * Append a message to the channel's store and return the stored record — or
 * `null` if, after sanitizing images, the message would be empty (no text and
 * no image that actually landed on disk). That keeps a bogus image ref with no
 * text from persisting a blank message.
 */
export function addChatMessage(
	channel: string,
	user: string,
	text: string,
	images?: unknown,
	opts?: { threadId?: unknown; replyTo?: unknown },
): ChatMessage | null {
	const imgs = sanitizeImages(images);
	const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
	if (!trimmed && imgs.length === 0) return null;
	const all = readAll(channel);
	// A thread reply must point at a message that exists in this channel;
	// replying to a reply re-roots onto its top-level parent (Slack semantics —
	// threads never nest).
	let threadId: string | undefined;
	if (
		typeof opts?.threadId === "string" &&
		/^[0-9a-f-]{36}$/i.test(opts.threadId)
	) {
		const parent = all.find((m) => m.id === opts.threadId);
		if (parent) threadId = parent.threadId || parent.id;
	}
	const replyTo = sanitizeReplyTo(opts?.replyTo);
	const message: ChatMessage = {
		id: crypto.randomUUID(),
		user: user.trim().slice(0, 64),
		text: trimmed,
		...(imgs.length ? { images: imgs } : {}),
		ts: Date.now(),
		...(threadId ? { threadId } : {}),
		...(replyTo ? { replyTo } : {}),
	};
	all.push(message);
	if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });
	writeJsonAtomic(fileFor(channel), { messages: all.slice(-MAX_STORED) });
	return message;
}

// Bound the reaction map so a hostile client can't balloon a message record.
const MAX_DISTINCT_REACTIONS = 24;

/**
 * Toggle `user`'s `emoji` reaction on a message. Returns the updated message,
 * or null when the message doesn't exist or the emoji/user is invalid.
 */
export function toggleChatReaction(
	channel: string,
	messageId: string,
	emoji: string,
	user: string,
): ChatMessage | null {
	const em = emoji.trim();
	const who = user.trim().slice(0, 64);
	// Reactions are short emoji tokens — reject anything long or with spaces.
	if (!who || !em || em.length > 16 || /\s/.test(em)) return null;
	const all = readAll(channel);
	const msg = all.find((m) => m.id === messageId);
	if (!msg) return null;
	const reactions: Record<string, string[]> = { ...(msg.reactions || {}) };
	const users = reactions[em] ? [...reactions[em]] : [];
	const idx = users.findIndex((u) => u.toLowerCase() === who.toLowerCase());
	if (idx >= 0) users.splice(idx, 1);
	else {
		if (!reactions[em] && Object.keys(reactions).length >= MAX_DISTINCT_REACTIONS)
			return null;
		users.push(who);
	}
	if (users.length) reactions[em] = users;
	else delete reactions[em];
	if (Object.keys(reactions).length) msg.reactions = reactions;
	else delete msg.reactions;
	writeJsonAtomic(fileFor(channel), { messages: all.slice(-MAX_STORED) });
	return msg;
}

/** Distinct display names who wrote in a thread (parent author + repliers). */
export function threadUsers(channel: string, threadId: string): string[] {
	const names = new Set<string>();
	for (const m of readAll(channel)) {
		if (m.id === threadId || m.threadId === threadId) names.add(m.user);
	}
	return [...names];
}

/**
 * Latest note per session channel — the sidebar's unread-note dots. One scan
 * over the chat dir; files are small and team-scale, so no cache.
 */
export function sessionNoteActivity(): Array<{
	sessionId: string;
	lastTs: number;
	lastUser: string;
}> {
	const out: Array<{ sessionId: string; lastTs: number; lastUser: string }> = [];
	try {
		for (const f of readdirSync(CHAT_DIR)) {
			// fileFor() writes "session:<id>" as "session_<id>" (unsafe-char
			// mapping) — recover the id from the filename.
			if (!f.startsWith("session_") || !f.endsWith(".json")) continue;
			const sessionId = f.slice("session_".length, -".json".length);
			const msgs = readAll(`session:${sessionId}`);
			const last = msgs[msgs.length - 1];
			if (!last) continue;
			out.push({ sessionId, lastTs: last.ts, lastUser: last.user });
		}
	} catch {}
	return out;
}

/**
 * Distinct teammates `@`-mentioned in `text` — never the sender themself.
 * `@session:<id>` tags don't collide: "session" is not a teammate name.
 */
export function mentionedUsers(text: string, sender: string): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(/@([A-Za-z][\w.-]*)/g)) {
		const name = CHAT_TEAM.find(
			(n) => n.toLowerCase() === m[1].toLowerCase(),
		);
		if (name && name.toLowerCase() !== sender.trim().toLowerCase())
			found.add(name);
	}
	return [...found];
}
