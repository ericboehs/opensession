/**
 * Everything pull-request: open-PR list, PR Tinder, per-session PR details/diff/comment/review/merge, PR agent actions, session-less PR previews.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { getPrDetails, getPrDiff, mergePr, postPrComment, submitPrReview } from "../pr-info";
import { closeTinderPr, commentTinderPr, deleteTinderComment, getSeenPrs, labelTinderPr, listTinderLabels, listTinderPrs, markPrSeen, markPrUnseen, reopenTinderPr } from "../pr-tinder";
import { findSession, invalidateSessionsCache } from "../session-cache";
import { getSessionControl } from "../session-control";
import { resolvePrTarget } from "../session-repos";
import { getOpenPrs } from "../sessions";
import { getRepo } from "../worktree";
import { watch } from "fs";

export async function handlePrRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Every open PR in the repo, attributed to teammates via the GitHub
	// identity table — the sidebar's Open PRs section (which must include
	// PRs that have no Backstage session).
	if (path === "/backstage/api/open-prs" && req.method === "GET") {
		return Response.json({ prs: getOpenPrs() });
	}

	// PR Tinder: the triage deck — every open tella-fusion PR with the
	// rich card fields, the repo's labels, and which PRs this user already
	// kept (so the deck doesn't re-deal them for 14 days).
	if (path === "/backstage/api/pr-tinder" && req.method === "GET") {
		const user = url.searchParams.get("user") || "";
		try {
			const [prs, labels] = await Promise.all([
				listTinderPrs(),
				listTinderLabels(),
			]);
			return Response.json({
				prs,
				labels,
				seen: user ? getSeenPrs(user) : [],
			});
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 502 },
			);
		}
	}

	// PR Tinder actions: keep (per-user, local state only), close (with an
	// optional reason comment), reopen (the close undo), comment, label.
	{
		const m = path.match(/^\/backstage\/api\/pr-tinder\/(\d+)\/(\w+)$/);
		if (m && req.method === "POST") {
			const number = parseInt(m[1], 10);
			const body = await req.json().catch(() => ({}));
			try {
				switch (m[2]) {
					case "keep": {
						if (!body.user)
							return Response.json(
								{ error: "user required" },
								{ status: 400 },
							);
						markPrSeen(body.user, number);
						return Response.json({ ok: true });
					}
					case "unkeep": {
						if (!body.user)
							return Response.json(
								{ error: "user required" },
								{ status: 400 },
							);
						markPrUnseen(body.user, number);
						return Response.json({ ok: true });
					}
					case "close": {
						const r = await closeTinderPr(number, body.reason);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "reopen": {
						const r = await reopenTinderPr(number);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "comment": {
						const r = await commentTinderPr(number, body.body || "");
						// Commenting is a triage verdict too — don't re-deal the PR.
						if ("ok" in r && body.user) markPrSeen(body.user, number);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "uncomment": {
						// Undo for a comment: delete it and put the PR back in the
						// user's deck.
						if (!body.commentId)
							return Response.json(
								{ error: "commentId required" },
								{ status: 400 },
							);
						const r = await deleteTinderComment(Number(body.commentId));
						if ("ok" in r && body.user) markPrUnseen(body.user, number);
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
					case "labels": {
						const r = await labelTinderPr(number, {
							add: body.add,
							remove: body.remove,
						});
						return Response.json(r, { status: "error" in r ? 502 : 200 });
					}
				}
			} catch (e: any) {
				return Response.json(
					{ error: e.message || String(e) },
					{ status: 500 },
				);
			}
		}
	}

	// PR details for a session's branch (PR tab). `?repo=<project>` targets an
	// attached repo's PR; `?repo=&branch=` a linked PR (which may be another
	// branch of the primary repo); default/primary the session's own branch.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		return Response.json(await getPrDetails(target.branch, target.ghRepo));
	}

	// PR diff for inline review in the PR tab
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-diff$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		return Response.json(await getPrDiff(target.branch, target.ghRepo));
	}

	// Link a PR to the session (a follow-up PR, or one in another repo/branch).
	// Body: { url } or { repo, number } or { repo, branch }.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/link-pr$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/link-pr$/)![1],
		);
		const body = await req.json().catch(() => ({}));
		try {
			const { linkPr } = await import("../session-repos");
			const result = await linkPr(sessionId, {
				url: body.url,
				repo: body.repo,
				number: body.number,
				branch: body.branch,
			});
			invalidateSessionsCache(); // session.prs / linkedPrs changed
			return Response.json({ ok: true, ...result });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// Unlink a PR (drops the link only — the PR itself is untouched). POST, not
	// DELETE, so it isn't swallowed by the generic DELETE /sessions/:id route.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/unlink-pr$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/unlink-pr$/)![1],
		);
		const body = await req.json().catch(() => ({}));
		if (!body.repo || !body.branch)
			return Response.json(
				{ error: "repo and branch required" },
				{ status: 400 },
			);
		try {
			const { unlinkPr } = await import("../session-repos");
			const all = unlinkPr(sessionId, body.repo, body.branch);
			invalidateSessionsCache();
			return Response.json({ ok: true, all });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// AI review guide for the PR tab's Guide view — generated on first
	// request per head commit (slow: a one-shot over the whole diff),
	// cached after that. null = no PR / generation failed (UI falls back
	// to the plain diff).
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/review-guide$/) &&
		req.method === "GET"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/review-guide$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const target = resolvePrTarget(
			session,
			url.searchParams.get("repo"),
			url.searchParams.get("branch"),
		);
		if (!target) return Response.json(null);
		const { getReviewGuide } = await import("../../server/review-guide");
		return Response.json(
			await getReviewGuide(target.branch, target.ghRepo),
		);
	}

	// Session-less PR preview (sidebar PR rows with no chat yet): PR details
	// and diff straight from repo+branch — same pr-info helpers as the
	// session routes, minus the session lookup.
	if (path === "/backstage/api/pr-preview" && req.method === "GET") {
		const branch = url.searchParams.get("branch") || "";
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		return Response.json(await getPrDetails(branch, repo.ghRepo));
	}
	if (path === "/backstage/api/pr-preview-diff" && req.method === "GET") {
		const branch = url.searchParams.get("branch") || "";
		if (!branch)
			return Response.json({ error: "branch required" }, { status: 400 });
		const repo = getRepo(url.searchParams.get("repo") || undefined);
		return Response.json(await getPrDiff(branch, repo.ghRepo));
	}

	// Post a comment on the session's PR (inline when path+line present)
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-comment$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		if (!body?.text?.trim())
			return Response.json({ error: "Empty comment" }, { status: 400 });
		const target = resolvePrTarget(session, body.repo, body.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);

		const user = body.user || "Someone";
		const result = await postPrComment(
			target.branch,
			{
				body: `**${user}** via Michael:\n\n${body.text.trim()}`,
				path: body.path,
				line: body.line,
				startLine: body.startLine,
				side: body.side,
				startSide: body.startSide,
			},
			target.ghRepo,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		return Response.json(result);
	}

	// Submit a batched review (all pending inline comments + an event) on the PR.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-review$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-review$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		const target = resolvePrTarget(session, body?.repo, body?.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		const event =
			body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
				? body.event
				: "COMMENT";
		const comments = Array.isArray(body?.comments) ? body.comments : [];
		if (!comments.length && !body?.summary?.trim()) {
			return Response.json({ error: "Nothing to submit" }, { status: 400 });
		}

		const user = body?.user || "Someone";
		const summary = body?.summary?.trim();
		const reviewBody = summary
			? `**${user}** via Michael:\n\n${summary}`
			: `Review by **${user}** via Michael.`;
		const result = await submitPrReview(
			target.branch,
			{
				event,
				body: reviewBody,
				comments: comments
					.filter((c: any) => c?.text?.trim() && c?.path && c?.line)
					.map((c: any) => ({
						path: c.path,
						line: c.line,
						startLine: c.startLine,
						side: c.side,
						startSide: c.startSide,
						body: `**${user}**: ${c.text.trim()}`,
					})),
			},
			target.ghRepo,
		);
		if ("error" in result) return Response.json(result, { status: 502 });
		invalidateSessionsCache(); // a review can change reviewDecision in the list
		return Response.json(result);
	}

	// Squash & merge the session's PR — human-triggered from the Reviews view.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-merge$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-merge$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => ({}));
		const target = resolvePrTarget(session, body.repo, body.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		const method =
			body.method === "merge" || body.method === "rebase"
				? body.method
				: "squash";
		try {
			const result = await mergePr(
				target.branch,
				{ method, deleteBranch: !!body.deleteBranch },
				target.ghRepo,
			);
			if ("error" in result) return Response.json(result, { status: 502 });
			invalidateSessionsCache(); // refresh prState in the sessions list
			return Response.json(result);
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 500 },
			);
		}
	}

	// Fire a GitHub PR agent behavior straight from the info panel — the same
	// actions the opensession-* PR labels / Slack @mentions kick off (review,
	// auto-fix, simplify, adversarial). tella-fusion only (the agent is
	// repo-scoped), and there must be an open PR for the branch.
	if (
		path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-action$/) &&
		req.method === "POST"
	) {
		const sessionId = decodeURIComponent(
			path.match(/^\/backstage\/api\/sessions\/(.+)\/pr-action$/)![1],
		);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });

		const body = await req.json().catch(() => null);
		const kind = body?.kind;
		if (!["review", "autofix", "simplify", "adversarial"].includes(kind))
			return Response.json({ error: "Unknown action" }, { status: 400 });

		const target = resolvePrTarget(session, body?.repo, body?.branch);
		if (!target)
			return Response.json(
				{ error: "No branch/PR for that repo" },
				{ status: 400 },
			);
		if (target.ghRepo !== "tellahq/tella-fusion")
			return Response.json(
				{ error: "The PR agent only runs on tella-fusion" },
				{ status: 400 },
			);

		const details = await getPrDetails(target.branch, target.ghRepo);
		if (!details?.number)
			return Response.json(
				{ error: "No open PR for this branch yet" },
				{ status: 400 },
			);

		// Auto-fix is code-writing work, not a review pass to post on the PR —
		// so it opens a live chat right in this workspace (shares the worktree +
		// branch) and fixes everything there, where you can watch and steer it,
		// instead of firing a headless GitHub-labeled run. The other actions
		// (review / simplify / adversarial) stay headless and post on the PR.
		if (kind === "autofix") {
			const prompt = [
				"/pr-autofix",
				"",
				`Fix everything on PR #${details.number} (“${details.title}”) — branch \`${target.branch}\`.`,
				"Address every reviewer's open feedback and any failing CI, commit and push to the branch,",
				"and reply in each thread you address with honest attribution. Keep going until it's all handled.",
			].join("\n");
			const { id } = await getSessionControl().createSession({
				prompt,
				repo: session.repo || "tella-fusion",
				mode: "code",
				branch: target.branch,
				parentSessionId: session.id,
				reportBack: false,
				user: body?.user || "Someone",
			});
			return Response.json({ ok: true, bksId: id, openChat: true });
		}

		const { triggerPrAction } = await import("../../agents/github/trigger");
		const result = await triggerPrAction(
			kind,
			details.number,
			body?.user || "Someone",
		);
		return Response.json({
			ok: result.ok,
			message: result.message,
			url: result.url,
			bksId: result.bksId,
			...(result.ok ? {} : { error: result.message }),
		});
	}

	return undefined;
}
