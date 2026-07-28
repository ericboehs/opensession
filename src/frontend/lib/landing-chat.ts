import type { Project, UnifiedSession } from "./types";

/**
 * The Review pane a chat surface should foreground by default. PR-backed
 * workspaces used to always land on Review; now the main chat leads whenever
 * the workspace has one — Review is the default surface only for chat-less
 * PR workspaces (a bare sidebar PR row with no sessions yet).
 */
export function defaultChatWorkspaceView(
	workspace: Pick<Project, "key" | "prNumber"> | null | undefined,
	reviewDismissed: boolean,
	hasLiveChat: boolean,
): "review" | null {
	const prBacked =
		workspace?.prNumber !== undefined || workspace?.key?.startsWith("ghpr-");
	return prBacked && !reviewDismissed && !hasLiveChat ? "review" : null;
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
 * A chat minted by the PR machinery (review/auto-fix/simplify/… runs) rather
 * than by a person: it supports the workspace's main line of work but is never
 * the conversation that started it.
 */
export function isAutomationChat(s: UnifiedSession): boolean {
	return !!s.automation || s.id.startsWith("bks-ghpr-");
}

/**
 * The workspace's MAIN chat from a createdAt-ascending list of its live chats:
 * the oldest human conversation that actually ran — the session that started
 * the whole thing — with automation chats (PR review/auto-fix runs) and
 * abandoned never-run shells passed over. Falls back gracefully when the
 * workspace only has automation chats or shells.
 */
export function mainChat(
	liveOldestFirst: UnifiedSession[],
): UnifiedSession | undefined {
	return (
		liveOldestFirst.find((s) => !isAutomationChat(s) && !chatNeverRan(s)) ??
		liveOldestFirst.find((s) => !chatNeverRan(s)) ??
		liveOldestFirst[0]
	);
}

/**
 * Keep the workspace's main chat at the leading edge while preserving the
 * user's saved order for every sibling chat.
 */
export function pinMainChatFirst(
	liveOldestFirst: UnifiedSession[],
	orderedIds: string[],
): string[] {
	const mainId = mainChat(liveOldestFirst)?.id;
	if (!mainId || !orderedIds.includes(mainId)) return orderedIds;
	return [mainId, ...orderedIds.filter((id) => id !== mainId)];
}

/**
 * The chat a workspace surface should land on when navigated without an
 * explicit chat id. Prefers the workspace's main chat (oldest human
 * conversation that ran — see mainChat); when every live chat is an abandoned
 * never-run shell — the real conversations were archived for staleness while
 * an empty "New chat" kept the workspace looking alive — falls back to the
 * newest archived conversation so the workspace's history stays reachable. A
 * never-run shell only wins when the workspace has no conversation with
 * content anywhere.
 *
 * `preferredId` — the chat last open in this workspace (workspace-last-chat.ts)
 * — wins outright while it's still a live chat here, so returning to a
 * workspace lands on the tab it was left on.
 */
export function pickLandingChat(
	all: UnifiedSession[],
	projectId: string,
	preferredId?: string,
): UnifiedSession | undefined {
	const live = all
		.filter((s) => !s.archived && s.projectId === projectId && !s.sideChatOf)
		.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
	const preferred = preferredId
		? live.find((s) => s.id === preferredId)
		: undefined;
	if (preferred) return preferred;
	const main = mainChat(live);
	if (main && !chatNeverRan(main)) return main;
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
