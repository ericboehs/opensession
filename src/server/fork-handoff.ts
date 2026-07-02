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

/**
 * Context bridge for an *in-place* engine switch: the same Backstage session
 * flipped its model from one provider to another (e.g. a Fable orchestrator
 * handing the wheel to a gpt-5.5 executor, or vice versa). The new engine has
 * no memory of the conversation so far — its provider's thread/session either
 * doesn't exist or is stale — so we hand it the recent transcript as a note.
 *
 * Unlike buildForkHandoffNote this is not a new session; it is the *continuation*
 * of an existing one, so the wording tells the new engine to pick up seamlessly
 * rather than treating it as a branch.
 */
export function buildEngineSwitchHandoffNote(input: {
	fromModel?: string | null;
	fromProvider: "claude" | "codex";
	toProvider: "claude" | "codex";
	/** True when the target engine is resuming its own earlier thread (Claude
	 *  coming back to a session it ran before) — then it already remembers the
	 *  turns up to the switch and only needs the other engine's turns since. */
	targetResuming?: boolean;
	entries: TranscriptEntry[];
	maxEntries?: number;
}): string {
	const maxEntries = input.maxEntries ?? 14;
	const useful = input.entries
		.filter((e) => ["user", "assistant", "system"].includes(e.type))
		.slice(-maxEntries);
	const lines = useful.map((e) => `- ${roleLabel(e.type)}: ${clip(e.content)}`);

	const fromLabel = input.fromModel
		? `${input.fromModel} (${input.fromProvider})`
		: input.fromProvider;

	return [
		"## Engine handoff",
		`This Backstage session was just switched mid-conversation from ${fromLabel} to you. You are continuing the *same* session, not starting a new task.`,
		input.targetResuming
			? "You resumed your own earlier thread in this session, so you remember the conversation up to the switch — the transcript below covers the turns the other engine ran in between, which you were not part of."
			: "The previous engine cannot transfer its internal conversation state to you, so treat the transcript below as the conversation so far and continue seamlessly.",
		lines.length
			? `Recent transcript:\n${lines.join("\n")}`
			: "No prior transcript entries were available.",
	]
		.filter(Boolean)
		.join("\n\n");
}
