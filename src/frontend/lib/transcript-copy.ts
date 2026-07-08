// Turn a chat's transcript into clipboard text — used by the tab context menu
// ("Copy concise/full transcript") and the ⌘⌥C shortcut. Entries are fetched
// fresh from the server, so this works for any tab, not just the open chat.
import { fetchTranscript } from "./api";
import { copyToClipboard } from "./share-link";
import type { TranscriptEntry, UnifiedSession } from "./types";

/**
 * Markdown rendering of a transcript. Concise keeps just the conversation
 * (user prompts + assistant replies); full also includes tool calls with
 * their input, tool results, and system entries.
 */
export function formatTranscript(
	entries: TranscriptEntry[],
	mode: "concise" | "full",
): string {
	const parts: string[] = [];
	for (const e of entries) {
		const text = (e.content || "").trim();
		if (e.type === "user" && text) {
			parts.push(`## User\n\n${text}`);
		} else if (e.type === "assistant" && text) {
			parts.push(`## Assistant\n\n${text}`);
		} else if (mode === "full") {
			if (e.type === "tool_use") {
				// `content` is the parser's one-line summary of the call.
				const input =
					e.toolInput === undefined
						? ""
						: `\n\n\`\`\`json\n${JSON.stringify(e.toolInput, null, 2)}\n\`\`\``;
				parts.push(`### Tool: ${e.toolName || "unknown"} — ${text}${input}`);
			} else if (e.type === "tool_result") {
				parts.push(
					`### Tool result${e.isError ? " (error)" : ""}\n\n\`\`\`\n${text}\n\`\`\``,
				);
			} else if (e.type === "system" && text) {
				parts.push(`### System\n\n${text}`);
			}
		}
	}
	return parts.join("\n\n");
}

/** Fetch, format, and copy a chat's transcript; reports the outcome via onToast. */
export async function copySessionTranscript(
	session: Pick<UnifiedSession, "id" | "title">,
	mode: "concise" | "full",
	onToast: (message: string) => void,
): Promise<void> {
	let entries: TranscriptEntry[];
	try {
		entries = ((await fetchTranscript(session.id)) as TranscriptEntry[]) || [];
	} catch {
		onToast("Couldn't load the transcript");
		return;
	}
	const body = formatTranscript(entries, mode);
	if (!body) {
		onToast("Nothing to copy yet");
		return;
	}
	copyToClipboard(`# ${session.title}\n\n${body}\n`, () =>
		onToast(
			mode === "concise"
				? "Concise transcript copied"
				: "Full transcript copied",
		),
	);
}
