export interface MentionPaletteSession {
	id: string;
	title?: string | null;
	branch?: string | null;
	repo?: string | null;
	source?: string | null;
	lastActivity?: string | null;
	archived?: boolean;
}

export interface MentionPaletteItem {
	display: string;
	insert: string;
	kind: "tool" | "session";
	sub?: string;
}

interface Options {
	query: string;
	toolNames: string[];
	sessions: MentionPaletteSession[];
	currentSessionId?: string | null;
}

function includesQuery(
	query: string,
	...values: Array<string | null | undefined>
): boolean {
	if (!query) return true;
	return values.some((value) => value?.toLowerCase().includes(query));
}

/** Non-file rows for the @ palette. Tools are intentionally uncapped: the
 * connected catalog is small and the request is to make every available tool
 * discoverable. Sessions are recent context rather than a second session
 * search screen, so that section stays bounded. */
export function mentionPaletteItems({
	query,
	toolNames,
	sessions,
	currentSessionId,
}: Options): MentionPaletteItem[] {
	const q = query.trim().toLowerCase();
	const tools = [...new Set(toolNames)]
		.filter((name) => includesQuery(q, name))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			display: name,
			insert: name,
			kind: "tool" as const,
		}));
	const matchingSessions = sessions
		.filter((session) => !session.archived && session.id !== currentSessionId)
		.filter((session) =>
			includesQuery(
				q,
				session.title,
				session.branch,
				session.repo,
				session.source,
				session.id,
			),
		);
	// Keep only the six newest matches while walking the catalog. Sorting the
	// entire session history on every character made a small picker scale with
	// years of archived work.
	const recent: MentionPaletteSession[] = [];
	for (const session of matchingSessions) {
		const at = session.lastActivity || "";
		const index = recent.findIndex(
			(candidate) => at > (candidate.lastActivity || ""),
		);
		if (index < 0) recent.push(session);
		else recent.splice(index, 0, session);
		if (recent.length > 6) recent.pop();
	}
	const sessionRows = recent
		.map((session) => ({
			display: session.title || session.branch || session.id,
			insert: `session:${session.id}`,
			kind: "session" as const,
			sub: session.branch || session.repo || session.source || undefined,
		}));
	return [...tools, ...sessionRows];
}
