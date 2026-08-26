/**
 * Read a Pi engine session's NATIVE jsonl (~/.opensession-pi/sessions/…) into
 * UI TranscriptEntries.
 *
 * Consumer: the workflow agent drill-in. Workflow agents run without an owning
 * Open Session session (journal `{ kind: "workflow" }`, no osSessionId), so
 * pi-runner deliberately does NOT persist their conversation into
 * transcripts.db — a store row under an id with no session would be swept as a
 * ghost transcript. Pi's native session file is then the only durable record,
 * and this module is how it gets read back.
 *
 * The native format is pi's v3 session log: `message` lines carrying
 * { role, content[] } where blocks are text | thinking | toolCall, plus
 * role "toolResult" messages with toolCallId/toolName. Thinking blocks are
 * dropped — like every other transcript surface, the drill-in renders the
 * conversation, not the model's scratchpad.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import { stateDir } from "./paths";
import { toolResultMedia } from "./transcript-media";

function piSessionsRoot(): string {
	return `${stateDir("pi")}/sessions`;
}

interface PiNativeBlock {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface PiNativeMessage {
	role?: string;
	content?: PiNativeBlock[] | string;
	toolCallId?: string;
	toolName?: string;
}

/**
 * Reverse index of every native pi session file: engine session id → path.
 * Same shape (and same cost argument) as sessions.ts's Claude transcript
 * index: one pass over the sessions root per TTL turns ~3k directory reads
 * into an O(1) hit for each drill-in poll, instead of a scan per request —
 * the UI polls every 2s while an agent runs.
 */
let indexCache: { map: Map<string, string>; ts: number } | null = null;
const INDEX_TTL = 2000;

function transcriptIndex(): Map<string, string> {
	if (indexCache && Date.now() - indexCache.ts < INDEX_TTL) return indexCache.map;
	const map = new Map<string, string>();
	const root = piSessionsRoot();
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		dirs = [];
	}
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = readdirSync(join(root, dir));
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const underscore = name.indexOf("_");
			if (underscore <= 0) continue;
			// <sortable-timestamp>_<engineSessionId>.jsonl — later timestamp wins.
			const id = name.slice(underscore + 1, -".jsonl".length);
			const path = join(root, dir, name);
			const prev = map.get(id);
			if (!prev || name > prev.split("/").pop()!) map.set(id, path);
		}
	}
	indexCache = { map, ts: Date.now() };
	return map;
}

/** Locate a native pi session file by its engine session id. */
export function findPiNativeTranscript(engineSessionId: string): string | null {
	const hit = transcriptIndex().get(engineSessionId);
	return hit && existsSync(hit) ? hit : null;
}

function blocks(message: PiNativeMessage): PiNativeBlock[] {
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string" && message.content)
		return [{ type: "text", text: message.content }];
	return [];
}

/** Parse one native pi session file into UI entries. Best-effort per line: a
 * malformed line skips rather than failing the whole read. */
export function readPiNativeTranscript(
	path: string,
	cap = 500,
): TranscriptEntry[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const entries: TranscriptEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let row: {
			type?: string;
			id?: string;
			timestamp?: string;
			message?: PiNativeMessage;
		};
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type !== "message" || !row.message) continue;
		const ts = row.timestamp || new Date(0).toISOString();
		const id = row.id;
		const role = row.message.role;

		if (role === "toolResult") {
			const content = blocks(row.message)
				.map((b) => b.text ?? "")
				.join("\n")
				.trim();
			entries.push({
				id: id ? `tr-${id}` : crypto.randomUUID(),
				type: "tool_result",
				content,
				timestamp: ts,
				...(row.message.toolCallId ? { toolUseId: row.message.toolCallId } : {}),
				...toolResultMedia(content),
			});
			continue;
		}

		for (const block of blocks(row.message)) {
			if (block.type === "text" && block.text?.trim()) {
				entries.push({
					id: id || crypto.randomUUID(),
					type: role === "assistant" ? "assistant" : "user",
					content: block.text,
					timestamp: ts,
				});
			} else if (block.type === "toolCall" && block.name) {
				entries.push({
					id: block.id || id || crypto.randomUUID(),
					type: "tool_use",
					content: `Using ${block.name}`,
					timestamp: ts,
					toolName: block.name,
					toolInput: block.arguments,
					...(block.id ? { toolUseId: block.id } : {}),
				});
			}
			// thinking blocks are deliberately dropped — see module comment.
		}
	}
	return entries.length > cap ? entries.slice(-cap) : entries;
}
