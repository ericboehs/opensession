import type { UnifiedSession } from "./types";
import { getWorkspace, type Workspace } from "./workspaces";

/**
 * The branch a chat's PR surfaces (tab, sidebar glyph, Reviews row) resolve on.
 *
 * A workspace owns the branch; its chats inherit it. Ask-style chats are filed
 * into a workspace and share its checkout on disk, but carry no `branch` of
 * their own — without the fallback they resolved to no PR at all, so one tab of
 * a workspace showed "Create PR" while its sibling showed the connected PR.
 *
 * Legacy GitHub review chats invert that: they store their local `*-os-review`
 * checkout as the session branch, and the PR-backed workspace retains the real
 * head branch, so the workspace wins over the chat there.
 *
 * Pass `workspace` to reuse an already-read record (see {@link prWorkspaceReader});
 * leaving it `undefined` reads it, `null` opts out of the lookup entirely.
 */
export function sessionPrBranch(
	session: UnifiedSession,
	workspace?: Workspace | null,
): string | null {
	const parent = () =>
		workspace === undefined && session.projectId
			? getWorkspace(session.projectId)
			: workspace;
	if (session.automation === "github-pr-review") {
		const owner = parent();
		return owner?.prNumber != null && owner.branch
			? owner.branch
			: session.branch;
	}
	return session.branch || parent()?.branch || null;
}

/**
 * A memoized workspace reader for callers that resolve many chats at once
 * (the `getAllSessions` PR enrichment). `getWorkspace` reads a file per call
 * and one workspace holds many chats, so the memo turns thousands of reads into
 * one per workspace. Chats that can't inherit a branch skip the read entirely —
 * {@link sessionPrBranch} never consults the workspace for those.
 */
export function prWorkspaceReader(): (s: UnifiedSession) => Workspace | null {
	const cache = new Map<string, Workspace | null>();
	return (session) => {
		if (!session.projectId) return null;
		if (session.branch && session.automation !== "github-pr-review") return null;
		let workspace = cache.get(session.projectId);
		if (workspace === undefined)
			cache.set(session.projectId, (workspace = getWorkspace(session.projectId)));
		return workspace;
	};
}
