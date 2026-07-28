/**
 * A session worktree's live git surface: diff, discard-file, status, push, pull.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import type { DiffGroupFile } from "../diff-groups";
import { type SessionDiff, discardSessionFile, getSessionDiff } from "../git-diff";
import { getGitStatus, gitPull, gitPush } from "../git-status";
import { imageContentType, imageHeaders } from "../image-mime";
import { hasRemoteWorkspace, workspaceExecFor } from "../sandbox";
import { findSession } from "../session-cache";
import { getRepo, repoForPath } from "../worktree";
import { defaultRepo } from "../config";
import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

function isDiffGroupFile(file: unknown): file is DiffGroupFile {
	if (typeof file !== "object" || file === null) return false;
	const candidate = file as Partial<DiffGroupFile>;
	return (
		typeof candidate.path === "string" &&
		candidate.path.length <= 1000 &&
		typeof candidate.additions === "number" &&
		typeof candidate.deletions === "number"
	);
}

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
					(session.worktreeDir && session.mode !== "scratch"
						? repoForPath(session.worktreeDir).id
						: defaultRepo().id),
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

	// AI file categories for the live worktree diff. This mirrors PR grouping,
	// but targets the top-level session Changes tab (including uncommitted edits).
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/diff-groups$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/diff-groups$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
			files?: unknown[];
			patch?: string;
		};
		const repoIds = [
			session.repo ||
				(session.worktreeDir && session.mode !== "scratch" ? repoForPath(session.worktreeDir).id : defaultRepo().id),
			...(session.attachedRepos || []).map((repo) => repo.repo),
		];
		if (!body.repo || !repoIds.includes(body.repo))
			return Response.json({ error: "Repo not in session" }, { status: 400 });
		if (!Array.isArray(body.files) || typeof body.patch !== "string")
			return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
		const files = body.files.filter(isDiffGroupFile);
		if (files.length !== body.files.length)
			return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
		const { getDiffFileGroups } = await import("../diff-groups");
		return Response.json({
			groups: await getDiffFileGroups(getRepo(body.repo).ghRepo, files, body.patch),
		});
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
			(session.worktreeDir && session.mode !== "scratch"
				? repoForPath(session.worktreeDir).id
				: defaultRepo().id);
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
			(session.worktreeDir && session.mode !== "scratch"
				? repoForPath(session.worktreeDir).id
				: defaultRepo().id);
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

	// An image from a session's worktree, for the Changes tab's diff view —
	// binary files have no textual hunks, so the client renders the picture
	// itself. `?side=new` (default) reads the working tree; `?side=base` shows
	// the pre-change version via `git show <merge-base>:<path>`.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/worktree-image$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/worktree-image$/)![1],
		);
		const session = findSession(sessionId);
		if (!session) return new Response("Session not found", { status: 404 });
		const filePath = url.searchParams.get("path") || "";
		const contentType = imageContentType(filePath);
		if (!contentType) return new Response("Not an image path", { status: 400 });
		const repoId = url.searchParams.get("repo");
		const primaryRepo =
			session.repo ||
			(session.worktreeDir && session.mode !== "scratch"
				? repoForPath(session.worktreeDir).id
				: defaultRepo().id);
		const isPrimary = !repoId || repoId === primaryRepo;
		const dir = isPrimary
			? session.worktreeDir
			: (session.attachedRepos || []).find((r) => r.repo === repoId)?.dir;
		if (!dir || !existsSync(dir)) return new Response("No worktree", { status: 404 });
		// Keep reads inside the worktree — the path comes from the client.
		const abs = resolve(dir, filePath);
		if (abs !== dir && !abs.startsWith(`${dir}/`))
			return new Response("Bad path", { status: 400 });
		try {
			if (url.searchParams.get("side") === "base") {
				const repoConf = getRepo(repoId || primaryRepo);
				const base = (
					await $`git -C ${dir} merge-base HEAD origin/${repoConf.defaultBranch}`
						.quiet()
						.text()
				).trim();
				const proc = Bun.spawn(["git", "-C", dir, "show", `${base}:${filePath}`], {
					stdout: "pipe",
					stderr: "ignore",
				});
				const bytes = await new Response(proc.stdout).arrayBuffer();
				if ((await proc.exited) !== 0)
					return new Response("Not in base", { status: 404 });
				return new Response(bytes, {
					headers: imageHeaders(contentType, "private, max-age=300"),
				});
			}
			const f = Bun.file(abs);
			if (!(await f.exists())) return new Response("Not found", { status: 404 });
			return new Response(f, {
				headers: imageHeaders(contentType, "no-cache"),
			});
		} catch {
			return new Response("Failed to read image", { status: 500 });
		}
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
			(session.worktreeDir && session.mode !== "scratch"
				? repoForPath(session.worktreeDir).id
				: defaultRepo().id);
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

	// Update the session's checkout — the Pull/Update action in the status
	// header. `body.base` merges origin/<default branch>; otherwise the branch's
	// own upstream is pulled fast-forward-only. Audited in git-status.ts.
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
			(session.worktreeDir && session.mode !== "scratch"
				? repoForPath(session.worktreeDir).id
				: defaultRepo().id);
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
