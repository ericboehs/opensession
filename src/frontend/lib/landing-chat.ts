import type { Project, UnifiedSession } from "./types";

export function defaultChatWorkspaceView(
	workspace: Pick<Project, "key" | "prNumber"> | null | undefined,
	reviewDismissed: boolean,
): "review" | null {
	const prBacked =
		workspace?.prNumber !== undefined || workspace?.key?.startsWith("ghpr-");
	return prBacked && !reviewDismissed ? "review" : null;
}

/**
 * True for an untouched "New chat" shell: never ran a turn (no engine session
 * on either provider), nothing running or queued, and no activity since
 * creation. These rows are minted eagerly by the new-chat endpoints so a tab
 * can render instantly; when abandoned they linger as empty shells.
 */
export function chatNeverRan(s: UnifiedSession): boolean {
	return (
		!s.claudeSessionId &&
		!s.codexThreadId &&
		!s.isRunning &&
		!(s.queuedCount && s.queuedCount > 0) &&
		s.lastActivity === s.createdAt
	);
}

/**
 * The chat a workspace surface should land on when navigated without an
 * explicit chat id. Prefers the first (oldest) live chat that has actually
 * run; when every live chat is an abandoned never-run shell — the real
 * conversations were archived for staleness while an empty "New chat" kept
 * the workspace looking alive — falls back to the newest archived
 * conversation so the workspace's history stays reachable. A never-run shell
 * only wins when the workspace has no conversation with content anywhere.
 */
export function pickLandingChat(
	all: UnifiedSession[],
	projectId: string,
): UnifiedSession | undefined {
	const live = all
		.filter((s) => !s.archived && s.projectId === projectId && !s.sideChatOf)
		.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
	const ran = live.find((c) => !chatNeverRan(c));
	if (ran) return ran;
	const archived = all
		.filter(
			(s) =>
				s.archived &&
				s.projectId === projectId &&
				!s.sideChatOf &&
				!chatNeverRan(s),
		)
		.sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""));
	return archived[0] ?? live[0];
}
