/**
 * Which sessions count as "the same workspace". Both the server and every
 * client apply this one rule.
 *
 * A workspace id alone does not answer it. The same branch can carry more than
 * one workspace record: a person makes a workspace for a branch, and the PR
 * agent mints its own `ghpr-<n>` one for the pull request opened from it (the
 * adopt-don't-duplicate rule in the server's workspace-resolve came later, so
 * the pairs already exist). Sessions filed under the second record then
 * disappear from the first one's history, and a workspace that has closed a
 * dozen tabs looks like it has closed none.
 *
 * So membership is: the workspace id, OR the same ISOLATED worktree. The
 * `/worktrees/` test is what keeps the second half honest. It is the same one
 * the tab strip uses to group workspace-less sessions, and it excludes a
 * repo's shared checkout, where a shared path says nothing about which work a
 * session belongs to.
 *
 * This lives in the protocol because both ends apply it and neither can see
 * the other's copy: the server filters the store with it (the workspace-scoped
 * archived slice), the web client merges what it already holds in memory with
 * it. A disagreement would not error: rows would flicker in and out of the
 * history menu as each fetch landed.
 */

/** The bits of a session that decide which workspace it belongs to. */
export interface WorkspaceGroupMember {
  workspaceId?: string | null;
  worktreeDir?: string | null;
}

/** The workspace being grouped around: its id and the worktree it owns. */
export interface WorkspaceGroup {
  workspaceId?: string | null;
  worktreeDir?: string | null;
}

/**
 * A worktree that identifies one piece of work, or null.
 *
 * Only an isolated worktree groups sessions. A repo's shared checkout is where
 * unrelated sessions all sit, so matching on it would sweep the whole repo
 * into one workspace's history.
 */
export function isolatedWorktree(dir?: string | null): string | null {
  return dir?.includes("/worktrees/") ? dir : null;
}

/** Whether this workspace is groupable at all (has an id or a worktree). */
export function hasWorkspaceGroup(group: WorkspaceGroup): boolean {
  return !!group.workspaceId || !!isolatedWorktree(group.worktreeDir);
}

/** Whether a session belongs to this workspace's group. */
export function inWorkspaceGroup(
  session: WorkspaceGroupMember,
  group: WorkspaceGroup,
): boolean {
  if (group.workspaceId && session.workspaceId === group.workspaceId)
    return true;
  const worktree = isolatedWorktree(group.worktreeDir);
  return !!worktree && session.worktreeDir === worktree;
}
