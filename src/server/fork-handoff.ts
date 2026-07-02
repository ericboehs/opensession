import type { TranscriptEntry } from "./types";

function clip(text: string, max = 1200): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function roleLabel(type: TranscriptEntry["type"]): string {
	switch (type) {
		case "user":
			return "User";
		case "assistant":
			return "Assistant";
		case "system":
			return "System";
		case "tool_use":
			return "Tool";
		case "tool_result":
			return "Tool result";
	}
}

export function buildForkHandoffNote(input: {
	sourceId: string;
	sourceTitle?: string | null;
	sourceModel?: string | null;
	messageId?: string;
	entries: TranscriptEntry[];
	maxEntries?: number;
}): string {
	const maxEntries = input.maxEntries ?? 12;
	let entries = input.entries;
	let boundary = "latest message";
	if (input.messageId) {
		const idx = entries.findIndex((e) => e.id === input.messageId);
		if (idx >= 0) {
			entries = entries.slice(0, idx + 1);
			boundary = `message ${input.messageId}`;
		} else {
			boundary = `latest message (requested fork point ${input.messageId} was not found)`;
		}
	}

	const useful = entries
		.filter((e) => ["user", "assistant", "system"].includes(e.type))
		.slice(-maxEntries);
	const lines = useful.map((e) => `- ${roleLabel(e.type)}: ${clip(e.content)}`);

	return [
		"## Fork handoff",
		`This is a new engine thread forked from Backstage session ${input.sourceId} at ${boundary}.`,
		input.sourceTitle ? `Source title: ${input.sourceTitle}` : undefined,
		input.sourceModel ? `Source model: ${input.sourceModel}` : undefined,
		"The original engine cannot clone its internal conversation state here, so use this transcript handoff as context and continue the requested work in this new session.",
		lines.length ? `Recent source transcript:\n${lines.join("\n")}` : "No source transcript entries were available.",
	]
		.filter(Boolean)
		.join("\n\n");
}
