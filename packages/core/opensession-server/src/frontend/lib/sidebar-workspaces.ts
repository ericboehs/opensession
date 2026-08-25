import type { UnifiedSession, Workspace } from "./types";

export function isScratchWorkspace(
	sessions: readonly Pick<UnifiedSession, "mode">[],
): boolean {
	return sessions.length > 0 && sessions.every((session) => session.mode === "scratch");
}

/**
 * The band repo-less Ask workspaces group into, pinned above the projects.
 *
 * A pseudo-band, not a repo: it is never written to the user's `repo-order`
 * pref, never drags, and is never a value of the repo filter. Keeping it out
 * of those keeps a namespace of real repo ids free of a sentinel that a repo
 * could one day be named.
 */
export const ASK_BAND = "__ask__";

/**
 * A workspace of nothing but repo-less Ask sessions — the "Ask" band that
 * sits above the project bands.
 *
 * Both halves are required. `mode` alone would sweep in every repo-scoped ask
 * session, which belongs in its repo's band; `repoLess` alone would sweep in
 * scratch. A workspace that mixes the two is not an Ask workspace and files
 * under its repo as usual.
 *
 * `repoLess`, never `!repo`: thousands of older ask sessions record no repo
 * and still sit in a real checkout, so `!repo` would empty every project band
 * into this one.
 */
export function isAskWorkspace(
	sessions: readonly Pick<UnifiedSession, "mode" | "repoLess">[],
): boolean {
	return (
		sessions.length > 0 &&
		sessions.every((session) => session.mode === "ask" && !!session.repoLess)
	);
}

export function spawnedSessionBelongsInSidebar(
	session: Pick<UnifiedSession, "spawnedBy">,
	needsAttention: boolean,
	claimed: boolean,
): boolean {
	return !session.spawnedBy || needsAttention || claimed;
}

export interface ActiveWorkspaceSubagent {
	session: UnifiedSession;
	/** One for a direct child of workspace work, increasing for nested workers. */
	depth: number;
}

/**
 * Active child sessions owned by one open workspace.
 *
 * `parentSessionId` is the relationship. A worker can carry the parent's
 * workspace, mint a temporary workspace of its own, or omit one, so workspace
 * equality alone is not enough: seed the family from sessions in the selected
 * workspace, then follow child edges. The returned rows remain live while a
 * worker is running, blocked on a question, or has queued work to deliver.
 */
export function activeSubagentsForWorkspace(
	sessions: readonly UnifiedSession[],
	workspaceId: string | null | undefined,
): ActiveWorkspaceSubagent[] {
	if (!workspaceId) return [];

	// The live session list should already be unique. Keeping the last copy of
	// a duplicate makes this helper defensive against an optimistic list merge
	// without ever rendering the same child twice.
	const byId = new Map<string, UnifiedSession>();
	for (const session of sessions) byId.set(session.id, session);

	const family = new Set<string>();
	const childrenByParent = new Map<string, string[]>();
	for (const session of byId.values()) {
		if (session.workspaceId === workspaceId) family.add(session.id);
		if (session.parentSessionId) {
			const children = childrenByParent.get(session.parentSessionId) ?? [];
			children.push(session.id);
			childrenByParent.set(session.parentSessionId, children);
		}
	}
	const queue = Array.from(family);
	for (let i = 0; i < queue.length; i++) {
		for (const childId of childrenByParent.get(queue[i]) ?? []) {
			if (family.has(childId)) continue;
			family.add(childId);
			queue.push(childId);
		}
	}

	const depthOf = (session: UnifiedSession): number => {
		let depth = 1;
		let parentId = session.parentSessionId;
		const seen = new Set([session.id]);
		while (parentId && family.has(parentId) && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent?.parentSessionId) break;
			depth++;
			parentId = parent.parentSessionId;
		}
		return depth;
	};

	return Array.from(byId.values())
		.filter(
			(session) =>
				family.has(session.id) &&
				!!session.parentSessionId &&
				!session.archived &&
				(session.isRunning ||
					!!session.waitingForInput ||
					(session.queuedCount ?? 0) > 0),
		)
		.map((session) => ({ session, depth: depthOf(session) }))
		.sort(
			(a, b) =>
				(a.session.createdAt || "").localeCompare(b.session.createdAt || "") ||
				a.session.id.localeCompare(b.session.id),
		);
}

/** The root session a workspace row should open, never one of its subagents. */
export function workspaceMainSession(row: {
	sessions: readonly UnifiedSession[];
}): UnifiedSession | null {
	if (row.sessions.length === 0) return null;
	const rowSessionIds = new Set(row.sessions.map((session) => session.id));
	return (
		row.sessions.find(
			(session) =>
				!session.parentSessionId || !rowSessionIds.has(session.parentSessionId),
		) ?? row.sessions[0]
	);
}

/**
 * Which workspace row a selected session belongs to. Usually the row that
 * lists it, but a session the sidebar deliberately keeps out of the rows — an
 * automation run, an unclaimed spawned worker — still belongs to its
 * workspace, so opening one keeps that workspace selected instead of leaving
 * the sidebar with nothing lit up. Falls back to the shared worktree for the
 * runs that carry no workspace.
 */
export function workspaceRowOwnsSession(
	row: {
		key: string;
		workspace: Pick<Workspace, "id"> | null;
		sessions: readonly Pick<UnifiedSession, "id">[];
	},
	selected: Pick<UnifiedSession, "id" | "workspaceId" | "worktreeDir"> | null,
): boolean {
	if (!selected) return false;
	if (row.sessions.some((session) => session.id === selected.id)) return true;
	if (selected.workspaceId) return row.workspace?.id === selected.workspaceId;
	return !!selected.worktreeDir && row.key === `wt:${selected.worktreeDir}`;
}

/** A workspace route can be selected before its first session exists. */
export function workspaceRowOwnsSelection(
	row: Parameters<typeof workspaceRowOwnsSession>[0],
	selectedSession: Parameters<typeof workspaceRowOwnsSession>[1],
	selectedWorkspaceId: string | null,
): boolean {
	return (
		(!!selectedWorkspaceId && row.workspace?.id === selectedWorkspaceId) ||
		workspaceRowOwnsSession(row, selectedSession)
	);
}
