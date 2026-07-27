/**
 * The "every chat lives in exactly one workspace" invariant.
 *
 * Workspaces (workspaces.ts) are what the sidebar's main list renders. A chat
 * carrying no `projectId` used to fall through to a *synthesized* row — grouped
 * by shared worktree, else one row per chat — so the sidebar had to model two
 * kinds of row forever. Instead, every chat that surfaces without a workspace
 * is filed into one here, at the single choke point where the unified session
 * list is assembled (`getAllSessions`).
 *
 * Why the read choke point rather than each creation path: chats arrive from
 * five of them (UI create, spawned children, the Slack loop, the Linear loop,
 * un-archiving), and two write their session files without this server ever
 * seeing the create. Enforcing it where every chat is read means no path can
 * regress the invariant — including ones added later. The creation paths that
 * *can* mint still do (ws-handlers, session-control-wiring): they know the
 * better name and can hook it up to the generated-title rename.
 *
 * The assignment is applied in-memory on the same scan and persisted right
 * after, so a brand-new chat never spends a poll interval row-less.
 *
 * Grouping fidelity: chats sharing an ISOLATED worktree land in ONE workspace —
 * the same rule the sidebar used to group its `wt:` rows, so no row fragments
 * when this lands. A shared checkout (a repo's live main checkout or its pinned
 * ask checkout) is owned by nobody: every chat there gets its own workspace.
 *
 * Automation runs are the deliberate exception. They live in the Automations
 * band, not the Workspaces list, and minting a workspace for each of the ~1100
 * live runs would bury every real one in the pickers. A run gets a workspace
 * only when something files it into one (automations.ts ticket filing), and a
 * *claimed* run is the one case the sidebar still renders without a workspace.
 */

import { createWorkspace, findWorkspaceByWorktree, getWorkspace } from "./workspaces";
import { isSharedCheckoutDir } from "./worktree";
import type { UnifiedSession } from "./types";

/**
 * Assignments whose file write hasn't landed yet. The persist is async and the
 * session scan re-runs every couple of seconds, so without this a chat would be
 * minted a second (and third) workspace before its first one hit disk. Parked
 * on globalThis so a hot reload doesn't lose the in-flight assignments.
 */
const pending: Map<string, string> = ((
  globalThis as unknown as { __ocPendingChatWorkspaces?: Map<string, string> }
).__ocPendingChatWorkspaces ??= new Map());

/**
 * The worktree this chat *owns*, or null. Shared checkouts don't count —
 * ownership is meaningless there (see isSharedCheckoutDir / findWorkspaceByWorktree).
 */
export function ownedWorktree(dir: string | null | undefined): string | null {
  return dir && !isSharedCheckoutDir(dir) ? dir : null;
}

/**
 * Name a workspace minted around existing chats, mirroring the names the
 * sidebar used to synthesize: a manual rename wins (explicit user intent),
 * then the shared branch for a worktree group, then the chat's own title.
 */
function nameFor(chats: UnifiedSession[], grouped: boolean): string {
  const renamed = chats.find((c) => c.titleOverridden);
  const name = grouped
    ? renamed?.title || chats[0].branch || chats[0].title
    : renamed?.title || chats[0].title || chats[0].branch;
  return (name || "Chat").slice(0, 120);
}

/** Persist the chat → workspace link (create-if-absent; a concurrent filing wins). */
function persist(chatId: string, workspaceId: string): void {
  // Lazy import: session-cache imports sessions.ts, which imports this module.
  // Deliberately NOT touchBackstageSession — that bumps lastActivity, which
  // would shoot every back-filled chat to the top of the sidebar.
  void import("./session-cache")
    .then(({ updateSessionFile }) =>
      updateSessionFile(chatId, (data) =>
        data.projectId || (data as { workspaceId?: string }).workspaceId
          ? data
          : { ...data, projectId: workspaceId, workspaceId },
      ),
    )
    .catch(() => {});
}

/**
 * File every workspace-less chat into a workspace, minting one where needed.
 * Mutates `sessions` in place (the caller's freshly assembled list) and writes
 * the link through best-effort — never throws, never blocks the scan.
 */
export function ensureChatWorkspaces(sessions: UnifiedSession[]): void {
  // Archived chats don't render, so they don't need one until they come back:
  // the same sweep files them on the scan right after an un-archive.
  const orphans = sessions.filter(
    (s) => !s.projectId && !s.archived && !s.automation,
  );
  if (orphans.length === 0) return;

  const fresh: UnifiedSession[] = [];
  for (const chat of orphans) {
    const inflight = pending.get(chat.id);
    // Drop a stale entry if the workspace was deleted out from under us, so the
    // chat gets a new one instead of pointing at nothing.
    if (inflight && getWorkspace(inflight)) chat.projectId = inflight;
    else {
      if (inflight) pending.delete(chat.id);
      fresh.push(chat);
    }
  }
  if (fresh.length === 0) return;

  // One workspace per owned worktree; every other chat is its own workspace.
  const groups = new Map<string, UnifiedSession[]>();
  for (const chat of fresh) {
    const dir = ownedWorktree(chat.worktreeDir);
    const key = dir ? `wt:${dir}` : `chat:${chat.id}`;
    const list = groups.get(key);
    if (list) list.push(chat);
    else groups.set(key, [chat]);
  }

  for (const [key, chats] of groups) {
    const dir = key.startsWith("wt:") ? key.slice(3) : null;
    chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    try {
      // Adopt the workspace that already owns this worktree before minting a
      // second one over it (a sibling chat may be filed there already).
      const workspace =
        (dir ? findWorkspaceByWorktree(dir) : null) ??
        createWorkspace({
          name: nameFor(chats, !!dir),
          repo: chats[0].repo,
          createdBy: chats[0].startedBy || "Anonymous",
          createdAt: chats[0].createdAt,
          ...(chats[0].branch ? { branch: chats[0].branch } : {}),
          ...(dir ? { worktreeDir: dir } : {}),
        });
      for (const chat of chats) {
        chat.projectId = workspace.id;
        pending.set(chat.id, workspace.id);
        persist(chat.id, workspace.id);
      }
    } catch (e) {
      // A chat with no workspace is still better than a failed scan.
      console.error(`[chat-workspace] failed to file ${chats[0]?.id}:`, e);
    }
  }
}
