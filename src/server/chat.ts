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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";

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

export interface ChatMessage {
	id: string;
	/** Sender's self-selected backstage-user display name ("Michiel"). */
	user: string;
	text: string;
	/** Attached images (may be empty/absent). */
	images?: ChatImage[];
	/** ms epoch */
	ts: number;
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

// Mentionable teammates. Keep in sync with TEAM in
// src/frontend/components/UserPicker.tsx — these picker names are also the
// keys push subscriptions are stored under (push.ts matches exact names).
const CHAT_TEAM = [
	"Michiel",
	"Jaap",
	"Kent",
	"Grant",
	"Johnny",
	"John",
	"Louise",
];

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
): ChatMessage | null {
	const imgs = sanitizeImages(images);
	const trimmed = text.trim().slice(0, MAX_TEXT_LEN);
	if (!trimmed && imgs.length === 0) return null;
	const message: ChatMessage = {
		id: crypto.randomUUID(),
		user: user.trim().slice(0, 64),
		text: trimmed,
		...(imgs.length ? { images: imgs } : {}),
		ts: Date.now(),
	};
	const all = readAll(channel);
	all.push(message);
	if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });
	writeJsonAtomic(fileFor(channel), { messages: all.slice(-MAX_STORED) });
	return message;
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
