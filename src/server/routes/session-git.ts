/**
 * A session worktree's live git surface: diff, discard-file, status, push, pull.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { type SessionDiff, discardSessionFile, getSessionDiff } from "../git-diff";
import { getGitStatus, gitPull, gitPush } from "../git-status";
import { hasRemoteWorkspace, workspaceExecFor } from "../sandbox";
import { findSession } from "../session-cache";
import { getRepo, repoForPath } from "../worktree";
import { existsSync } from "fs";

export async function handleSessionGitRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Live git diff for a session's worktree (Changes tab)
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/diff$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		// One diff per repo in the session: primary worktree + each attached repo.
		// Each carries its repo id so the panel can show a repo switcher and
		// route per-line feedback to the right checkout.
		const targets: Array<{
			repo: string;
			dir: string | null;
			primary: boolean;
		}> = [
			{
				repo:
					session.repo ||
					(session.worktreeDir
						? repoForPath(session.worktreeDir).id
						: "tella-fusion"),
				dir: session.worktreeDir,
				primary: true,
			},
			...(session.attachedRepos || []).map((r) => ({
				repo: r.repo,
				dir: r.dir,
				primary: false,
			})),
		];

		const repos = await Promise.all(
			targets.map(async (t) => {
				let diff: SessionDiff = {
					branch: null,
					baseRef: null,
					files: [],
					totalAdditions: 0,
					totalDeletions: 0,
					rawPatch: "",
				};
				// Volume-mode sandbox workspaces have no host dir — the primary
				// repo's diff runs through the session's sandbox exec instead
				// (workspaceExecFor; host exec when no active sandbox). Attached
				// repos are always host worktrees.
				const remote = t.primary && hasRemoteWorkspace(session);
				if (t.dir && (existsSync(t.dir) || remote)) {
					try {
						diff = await getSessionDiff(
							t.dir,
							getRepo(t.repo).defaultBranch,
							t.primary ? await workspaceExecFor(session, t.dir) : undefined,
						);
					} catch {}
				}
				return { repo: t.repo, dir: t.dir, primary: t.primary, diff };
			}),
		);

		return Response.json({ repos });
	}

	// Discard one file's changes in a session worktree (hover action on a
	// diff row). `{ repo, path, oldPath? }` — resets the file to its
	// base-branch state so it drops out of the Changes diff. Destructive.
	const discardMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/discard-file$/,
	);
	if (discardMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(discardMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
			path?: string;
			oldPath?: string;
		};
		if (!body.path)
			return Response.json({ error: "Missing path" }, { status: 400 });

		// Resolve the worktree dir for the targeted repo (primary or attached).
		const primaryRepo =
			session.repo ||
			(session.worktreeDir
				? repoForPath(session.worktreeDir).id
				: "tella-fusion");
		let dir: string | null = null;
		let repoId = primaryRepo;
		if (!body.repo || body.repo === primaryRepo) {
			dir = session.worktreeDir;
		} else {
			const att = (session.attachedRepos || []).find(
				(r) => r.repo === body.repo,
			);
			dir = att?.dir ?? null;
			repoId = body.repo;
		}
		// Primary volume-mode workspaces exist only in the sandbox — route the
		// discard through its exec instead of requiring a host dir.
		const primaryRemote =
			(!body.repo || body.repo === primaryRepo) && hasRemoteWorkspace(session);
		if (!dir || (!existsSync(dir) && !primaryRemote))
			return Response.json(
				{ error: "No worktree for this repo" },
				{ status: 400 },
			);

		try {
			await discardSessionFile(
				dir,
				getRepo(repoId).defaultBranch,
				body.path,
				body.oldPath,
				!body.repo || body.repo === primaryRepo
					? await workspaceExecFor(session, dir)
					: undefined,
			);
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to discard file" },
				{ status: 500 },
			);
		}
		return Response.json({ ok: true });
	}

	// Local git state for a session's worktree (status header + Git status
	// rows). `?repo=<project>` targets an attached repo's checkout.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/git-status$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/git-status$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const repoId = url.searchParams.get("repo");
		const primaryRepo =
			session.repo ||
			(session.worktreeDir
				? repoForPath(session.worktreeDir).id
				: "tella-fusion");
		const isPrimary = !repoId || repoId === primaryRepo;
		const dir = isPrimary
			? session.worktreeDir
			: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
		// Primary volume-mode workspaces have no host dir — status runs
		// through the sandbox exec (host exec when no active sandbox).
		const remote = isPrimary && hasRemoteWorkspace(session);
		if (!dir || (!existsSync(dir) && !remote)) return Response.json(null);
		const repoConf = getRepo(repoId || primaryRepo);
		return Response.json(
			await getGitStatus(
				dir,
				repoConf.defaultBranch,
				isPrimary ? await workspaceExecFor(session, dir) : undefined,
			),
		);
	}

	// Push the session's branch (sets upstream on first push). Human-triggered
	// from the status header — audited in git-status.ts.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/git-push$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/git-push$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const repoId = typeof body?.repo === "string" ? body.repo : null;
		const primaryRepo =
			session.repo ||
			(session.worktreeDir
				? repoForPath(session.worktreeDir).id
				: "tella-fusion");
		const isPrimary = !repoId || repoId === primaryRepo;
		const dir = isPrimary
			? session.worktreeDir
			: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
		if (!dir || (!existsSync(dir) && !(isPrimary && hasRemoteWorkspace(session))))
			return Response.json(
				{ error: "Session has no worktree" },
				{ status: 400 },
			);
		const result = await gitPush(
			dir,
			session.branch || "HEAD",
			isPrimary ? await workspaceExecFor(session, dir) : undefined,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		return Response.json(result);
	}

	// Fast-forward the session's checkout (git pull --ff-only) — the Pull
	// action in the status header. `body.base` pulls origin/<default branch>
	// instead of the branch's upstream (fresh worktree branches behind base
	// have no upstream to pull from). Audited in git-status.ts.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/git-pull$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/git-pull$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = await req.json().catch(() => ({}));
		const repoId = typeof body?.repo === "string" ? body.repo : null;
		const primaryRepo =
			session.repo ||
			(session.worktreeDir
				? repoForPath(session.worktreeDir).id
				: "tella-fusion");
		const isPrimary = !repoId || repoId === primaryRepo;
		const dir = isPrimary
			? session.worktreeDir
			: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
		if (!dir || (!existsSync(dir) && !(isPrimary && hasRemoteWorkspace(session))))
			return Response.json(
				{ error: "Session has no worktree" },
				{ status: 400 },
			);
		const result = await gitPull(
			dir,
			body?.base ? getRepo(repoId || primaryRepo).defaultBranch : undefined,
			isPrimary ? await workspaceExecFor(session, dir) : undefined,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		return Response.json(result);
	}

	return undefined;
}
