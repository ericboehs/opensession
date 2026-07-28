import type { UnifiedSession } from "./types";
import { getWorkspace, type Workspace } from "./workspaces";

/**
 * Legacy GitHub review chats can store their local `*-os-review` checkout as
 * the session branch. Their PR-backed workspace retains the real head branch.
 */
export function sessionPrBranch(
	session: UnifiedSession,
	workspace?: Workspace | null,
): string | null {
	if (session.automation !== "github-pr-review") return session.branch;
	const parent =
		workspace === undefined && session.projectId
			? getWorkspace(session.projectId)
			: workspace;
	return parent?.prNumber != null && parent.branch
		? parent.branch
		: session.branch;
}
