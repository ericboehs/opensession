import type { UnifiedSession } from "./types";
import { getWorkspace, type Workspace } from "./workspaces";

/** The PR branch `session` can take from `workspace`, or null. Never across
 *  repos: a chat in another repo would resolve to a branch absent there. */
function inheritedBranch(
	session: UnifiedSession,
	workspace: Workspace | null | undefined,
): string | null {
	if (!workspace?.branch) return null;
	if (session.repo && workspace.repo && session.repo !== workspace.repo)
		return null;
	return workspace.branch;
}

/**
 * The branch a chat's PR surfaces (tab, sidebar glyph, Reviews row) resolve on.
 *
 * A workspace owns the branch; a chat with none of its own inherits it.
 * Ask-style chats are filed into a workspace and share its checkout on disk but
 * store no `branch`, so without the fallback they resolved to no PR at all —
 * one tab of a workspace offered "Create PR" while its sibling showed the
 * workspace's connected PR.
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
	const parent =
		workspace === undefined && session.projectId
			? getWorkspace(session.projectId)
			: workspace;
	if (session.automation === "github-pr-review")
		return parent?.prNumber != null && parent.branch
			? parent.branch
			: session.branch;
	return session.branch || inheritedBranch(session, parent);
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
