/**
 * Native Backstage team chat — nothing to do with Slack. Two kinds of rooms
 * share one implementation, keyed by channel id:
 *
 *   - "watercooler"      the team-wide room (left-sidebar entry)
 *   - "session:<id>"     a per-session room (the session panel's Chat tab)
 *
 * Messages persist per channel in `~/.backstage-chat/<channel>.json` (the
 * flat-file pattern of pins.ts/push.ts); realtime delivery and typing
 * indicators ride the app WebSocket (wired in backstage.ts). An `@Name`
 * mention web-pushes the tagged teammate's devices via src/server/push.ts.
 * `@session:<id>` tokens tag a session — rendered as a clickable chip by the
 * frontend, ignored by mention pushes.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";

const HOME = process.env.HOME || "/home/ubuntu";
const CHAT_DIR = `${HOME}/.backstage-chat`;

// Keep each channel's store bounded — the UI only ever loads the recent tail.
const MAX_STORED = 5000;
const MAX_TEXT_LEN = 8000;

export interface ChatMessage {
	id: string;
	/** Sender's self-selected backstage-user display name ("Michiel"). */
	user: string;
	text: string;
	/** ms epoch */
	ts: number;
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
	} catch {
		return [];
	}
}

/** The channel's most recent `limit` messages, oldest first. */
export function getChatMessages(channel: string, limit = 200): ChatMessage[] {
	const capped = Math.max(1, Math.min(limit, MAX_STORED));
	return readAll(channel).slice(-capped);
}

/** Append a message to the channel's store and return the stored record. */
export function addChatMessage(
	channel: string,
	user: string,
	text: string,
): ChatMessage {
	const message: ChatMessage = {
		id: crypto.randomUUID(),
		user: user.trim().slice(0, 64),
		text: text.trim().slice(0, MAX_TEXT_LEN),
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
