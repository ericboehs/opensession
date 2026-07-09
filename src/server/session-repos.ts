/**
 * Session ↔ repo derivations: which repos a session spans, the per-run
 * system-prompt notes built from that (branch discipline, multi-repo map,
 * memory), PR-target resolution, and the attach/switch-primary repo
 * operations behind the RepoBar + opensession-repos tools.
 */

import {
	createWorktree,
	getRepo,
	listWorktrees,
	prepareAttachedWorktree,
	repoForPath,
	REPOS,
	worktreeHasWork,
} from "./worktree";
import { hasRemoteWorkspace } from "./sandbox";
import { findWorkspaceByWorktree, type Workspace } from "./workspaces";
import {
	renderSessionMemoryNote,
	sessionMemoryScopes,
} from "./session-memory";
import { findSession, touchBackstageSession } from "./session-cache";
import type { AttachedRepo, UnifiedSession } from "./types";

/**
 * Branch discipline for interactive code sessions in isolated worktrees. Chats
 * in one workspace share a single worktree + branch, so each agent must treat
 * that branch as THE branch — sibling commits included. Without this, each
 * sibling chat decided the extra commits on the shared branch weren't its own
 * and cherry-picked onto a fresh branch, producing one PR per chat instead of
 * one per workspace (tella-fusion PRs #4529–#4531).
 */
export function buildBranchNote(session: {
	mode?: "ask" | "code";
	branch?: string | null;
	worktreeDir?: string | null;
}): string | undefined {
	if (session.mode === "ask" || !session.branch || !session.worktreeDir)
		return undefined;
	const repo = repoForPath(session.worktreeDir);
	// Shared-checkout repos (backstage) and main-checkout cwds have their own
	// rules; this note is for isolated per-branch worktrees only.
	if (repo.sharedCheckout || session.worktreeDir === repo.repo)
		return undefined;
	return [
		"## Branch discipline (shared worktree)",
		`You are working in \`${session.worktreeDir}\` on branch \`${session.branch}\`. Other chats in this workspace share this exact worktree and branch — commits you don't recognize are their work, not noise.`,
		`Stay on \`${session.branch}\`: never create or switch branches, and never rebase away, reset, or cherry-pick around sibling commits. Commit your changes on this branch and push with \`git push origin ${session.branch}\`.`,
		`This workspace keeps ONE pull request: if an open PR for \`${session.branch}\` already exists, pushing updates it — do not open another. Only run \`gh pr create\` when the branch has no open PR. Never merge.`,
		"Only deviate from this (separate branch or separate PR) when the user explicitly asks for it.",
	].join("\n");
}

/**
 * System-prompt note describing a session's repos when it spans more than one.
 * Lists the primary worktree + every attached repo with its path/branch and how
 * `@<project>:path` mentions resolve. Returns undefined for single-repo sessions
 * so the prompt stays clean.
 */
export function buildReposNote(session: UnifiedSession): string | undefined {
	const branchNote = buildBranchNote(session);
	const attached = session.attachedRepos || [];
	if (!attached.length) return branchNote;
	const primaryRepo =
		session.repo ||
		(session.worktreeDir
			? repoForPath(session.worktreeDir).id
			: "tella-fusion");
	const lines = [
		"## Repos in this session",
		"This session spans multiple repos. Each is an isolated git worktree — `cd` into the right one to read or edit its files, and commit/push/open PRs in each repo independently (don't edit another repo's shared main checkout).",
		`- **${primaryRepo}** (primary): ${session.worktreeDir}${session.branch ? ` — branch \`${session.branch}\`` : ""}`,
	];
	for (const r of attached)
		lines.push(`- **${r.repo}**: ${r.dir} — branch \`${r.branch}\``);
	lines.push(
		"A file mentioned from an attached repo arrives as `@<project>:<path>` — resolve it under that repo's worktree dir above.",
	);
	return [branchNote, lines.join("\n")].filter(Boolean).join("\n\n");
}

/** Repo ids a session spans, primary first — memory scopes + repos note agree on this. */
export function sessionRepoIds(session: UnifiedSession): string[] {
	const primary =
		session.repo ||
		(session.worktreeDir
			? repoForPath(session.worktreeDir).id
			: "tella-fusion");
	return [primary, ...(session.attachedRepos || []).map((r) => r.repo)];
}

/**
 * The full per-session system-prompt note for an interactive run: repos/branch
 * discipline (buildReposNote) + the session's repo/user/team memory. Memory
 * failures never block a run — the note just goes out without it.
 */
export async function buildSessionNote(
	session: UnifiedSession,
	user?: string,
): Promise<string | undefined> {
	return (
		[buildReposNote(session), await memoryNoteFor(user, sessionRepoIds(session))]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** The repo/user/team memory prompt section for a run (with tool guidance —
 *  callers are interactive paths only). Never throws: a memory failure must
 *  not block a run, the note just goes out without it. */
export async function memoryNoteFor(
	user: string | undefined,
	repos: string[],
): Promise<string> {
	try {
		return await renderSessionMemoryNote(
			sessionMemoryScopes({ user, repos }),
			{ tools: true },
		);
	} catch (e) {
		console.warn("[memory] failed to render session memory note:", e);
		return "";
	}
}

/**
 * Resolve which GitHub repo + branch a PR operation targets. With no `repo`
 * query (or the primary project's id) it's the session's primary branch; an
 * attached project id targets that repo on its attached branch. Returns null
 * when there's no branch to act on.
 */
export function resolvePrTarget(
	session: UnifiedSession,
	repoId?: string | null,
): { ghRepo: string; branch: string } | null {
	const primaryRepo =
		session.repo ||
		(session.worktreeDir
			? repoForPath(session.worktreeDir).id
			: "tella-fusion");
	if (!repoId || repoId === primaryRepo) {
		if (!session.branch) return null;
		return {
			ghRepo: getRepo(primaryRepo).ghRepo,
			branch: session.branch,
		};
	}
	const att = (session.attachedRepos || []).find(
		(r) => r.repo === repoId,
	);
	if (!att) return null;
	return { ghRepo: getRepo(att.repo).ghRepo, branch: att.branch };
}

/**
 * The workspace that already owns this worktree, or null. Adopt-don't-duplicate:
 * every create path that's about to wrap a chat in a fresh workspace checks here
 * first, so landing on an already-owned worktree joins the existing workspace
 * instead of minting a second one over it. Repo main checkouts never match —
 * they're shared by every backstage/ask chat, so ownership is meaningless there.
 */
export function workspaceOwningWorktree(
	worktreeDir: string | null | undefined,
): Workspace | null {
	if (!worktreeDir) return null;
	if (Object.values(REPOS).some((r) => r.repo === worktreeDir)) return null;
	return findWorkspaceByWorktree(worktreeDir);
}

/**
 * Attach a secondary repo to a session: create (or reuse) an isolated worktree
 * for `repoId` and record it on the session. The attached branch defaults to
 * the session's primary branch so cross-repo work shares one branch name (and
 * the PRs line up). Re-attaching the same project just updates its entry. Only
 * code sessions on a real worktree can attach — Ask/main-checkout sessions and
 * the primary project itself are rejected.
 */
export async function attachRepo(
	sessionId: string,
	repoId: string,
	branch?: string,
): Promise<{ attached: AttachedRepo; all: AttachedRepo[] }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Can't attach a repo to an Ask (read-only) session");
	if (hasRemoteWorkspace(session))
		throw new Error(
			"This session's workspace lives inside its sandbox volume — attached repos aren't supported in volume mode yet (use a bind-mode sandbox or a plain worktree session for multi-repo work)",
		);
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is this session's primary repo`);

	const effectiveBranch = (branch || session.branch || "").trim();
	if (!effectiveBranch) {
		throw new Error("No branch to attach on — pass a branch name");
	}

	const attached = await prepareAttachedWorktree(repoId, effectiveBranch);
	const existing = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	const all = [...existing, attached];
	touchBackstageSession(sessionId, { attachedRepos: all });
	return { attached, all };
}

/**
 * Switch a session's PRIMARY repo — for when the wrong repo was picked at
 * creation. Clean-only by design: allowed only while the session's worktree has
 * no uncommitted changes and no commits beyond its base, so no work is ever
 * silently stranded (a session that already committed keeps its old repo). The
 * session's branch name is reused in the target repo (keeping any cross-repo
 * PRs aligned); the next prompt runs from the new worktree because
 * runSessionPrompt re-reads `cwd` from `worktreeDir` each turn.
 */
export async function switchPrimaryRepo(
	sessionId: string,
	repoId: string,
	force = false,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	const session = findSession(sessionId);
	if (!session) throw new Error("Session not found");
	if (session.mode === "ask")
		throw new Error("Ask sessions read the main checkout — nothing to switch");
	if (!REPOS[repoId]) throw new Error(`Unknown repo "${repoId}"`);
	if (session.repo === repoId)
		throw new Error(`${repoId} is already this session's primary repo`);
	// A switch just repoints the session at a different worktree — the old one
	// (branch, commits, uncommitted edits) stays on disk, so nothing is ever
	// destroyed. We still block by default when there's work so the agent-facing
	// switch_repo tool can't silently abandon it; the human UI passes force=true
	// after confirming, since fixing a wrong-repo choice is exactly that case.
	if (
		!force &&
		session.worktreeDir &&
		session.branch &&
		(await worktreeHasWork(session.worktreeDir, session.branch, session.repo))
	)
		throw new Error(
			"This session already has work — switching repos is only allowed on a fresh session",
		);

	const target = getRepo(repoId);
	let wtPath: string;
	let branch: string;
	if (target.sharedCheckout) {
		// Backstage: sessions edit the live main checkout on its default branch.
		wtPath = target.repo;
		branch = target.defaultBranch;
	} else {
		branch = (session.branch || "").trim();
		if (!branch) throw new Error("Session has no branch to carry over");
		const worktrees = await listWorktrees(target.id);
		wtPath =
			worktrees.find((w) => w.branch === branch)?.path ||
			(await createWorktree(branch, target.id));
	}

	// Drop the target from attached repos if it was attached — it's the primary now.
	const attachedRepos = (session.attachedRepos || []).filter(
		(r) => r.repo !== repoId,
	);
	touchBackstageSession(sessionId, {
		repo: target.id,
		worktreeDir: wtPath,
		branch,
		attachedRepos,
	});
	return { repo: target.id, branch, worktreeDir: wtPath };
}
