import {
	shareShippedVisualChange,
	shippedChangeChannels,
} from "../../agents/github/shipped-change-notify";
import { shippedChangesChannel } from "../../agents/github/constants";
import { findSession, updateSessionFile } from "../session-cache";
import type { SessionSlackShare } from "../types";
import { resolvePrTarget } from "../session-repos";
import { prHostFor } from "../pr-host";
import { getRepo } from "../worktree";
import { requestUser, type RouteContext } from "./context";

export async function handleShippedChangeRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;
	const match = path.match(/^\/api\/sessions\/([^/]+)\/share-shipped-change$/);
	if (!match || (req.method !== "GET" && req.method !== "POST")) return;
	const session = findSession(decodeURIComponent(match[1]));
	if (!session)
		return Response.json({ error: "Session not found" }, { status: 404 });
	if (req.method === "GET") {
		const caller = ctx.authUser?.login || ctx.authUser?.name;
		const { mcpUserGrantToken } = await import("../mcp-oauth");
		const slackToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
		let canUploadImages = false;
		if (slackToken) {
			try {
				const response = await fetch("https://slack.com/api/auth.test", {
					headers: { Authorization: `Bearer ${slackToken}` },
					signal: AbortSignal.timeout(5_000),
				});
				canUploadImages = (response.headers.get("x-oauth-scopes") || "")
					.split(",")
					.map((scope) => scope.trim())
					.includes("files:write");
			} catch {}
		}
		return Response.json({
			channels: shippedChangeChannels(),
			defaultChannel: shippedChangesChannel(),
			canUploadImages,
		});
	}
	const body = await req.json().catch(() => ({}));
	const caller = ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx, body?.user);
	const { mcpUserGrantToken } = await import("../mcp-oauth");
	const slackToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
	const target = resolvePrTarget(session, body?.repo, body?.branch);
	if (!target)
		return Response.json({ error: "Pull request target not found" }, { status: 404 });
	const repo = getRepo(target.repoId);
	const pr = await prHostFor(repo).getPrDetails(target.branch, target.ghRepo);
	if (!pr)
		return Response.json({ error: "Pull request not found" }, { status: 404 });
	if (pr.state !== "MERGED")
		return Response.json(
			{ error: "Share to Slack is available after the pull request merges" },
			{ status: 409 },
		);

	try {
		const result = await shareShippedVisualChange({
			session,
			pr: { number: pr.number, title: pr.title, url: pr.url },
			repoFullName: target.ghRepo,
			requestedBy: requestUser(ctx, body?.user),
			channel: body?.channel,
			message: body?.message,
			slackToken,
			screenshots: Array.isArray(body?.screenshots)
				? body.screenshots.filter((path: unknown): path is string => typeof path === "string")
				: undefined,
		});
		// The receipt is what collapses the share card, on reload and for every
		// other viewer, so record it before answering.
		const share: SessionSlackShare | undefined = result.channel && {
			channelId: result.channel.id,
			channelName: result.channel.name,
			permalink: result.permalink,
			at: new Date().toISOString(),
			by: caller,
			prNumber: pr.number,
		};
		if (share) {
			await updateSessionFile(session.id, (data) => ({
				...data,
				slackShares: [...(data.slackShares || []), share].slice(-20),
			}));
		}
		return Response.json({ ...result, share });
	} catch (error: any) {
		if (error?.message === "SLACK_RECONNECT_REQUIRED") {
			return Response.json(
				{ error: "Reconnect Slack to add image access, then send again" },
				{ status: 403 },
			);
		}
		return Response.json(
			{ error: error?.message || "Couldn't share the shipped update" },
			{ status: 502 },
		);
	}
}
