/**
 * Slack channel Conversation tab (the Plain-thread sibling for slack-channel
 * feed workspaces): paginated channel history + post-a-message. Human-gated
 * browser routes — agent runs post through the slack MCP instead.
 *
 * Identity: reads use the signed-in caller's Slack grant when they have one
 * (their visibility, incl. private channels), bot token otherwise. POSTING
 * requires the caller's own grant — messages appear AS THEM (that's the
 * point); without a grant the route 403s with a pointer to My accounts.
 */
import type { RouteContext } from "./context";

export async function handleSlackChannelRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path } = ctx;

	const msgsMatch = path.match(
		/^\/backstage\/api\/slack\/channels\/([^/]+)\/messages$/,
	);
	if (!msgsMatch) return undefined;
	const channelId = decodeURIComponent(msgsMatch[1]);
	const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
	const { mcpUserGrantToken } = await import("../mcp-oauth");
	const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;

	if (req.method === "GET") {
		// Newest page by default; `before=<ts>` pages older (exclusive), the
		// same shape the transcript's Load-history uses.
		const before = url.searchParams.get("before") || undefined;
		const limit = Math.min(
			Math.max(parseInt(url.searchParams.get("limit") || "40", 10) || 40, 1),
			100,
		);
		try {
			const { slackApiCall, resolveSlackUser, prettifyMentions } =
				await import("../../agents/slack/slack-api");
			const { personaName } = await import("../config");
			const data = await slackApiCall(
				"conversations.history",
				{
					channel: channelId,
					limit,
					...(before ? { latest: before, inclusive: false } : {}),
				},
				grantToken,
			);
			if (!data?.ok)
				return Response.json(
					{ error: data?.error || "history failed" },
					{ status: 502 },
				);
			const chronological = [...(data.messages || [])].reverse();
			const out: unknown[] = [];
			for (const m of chronological) {
				if (m.type !== "message") continue;
				if (m.subtype && m.subtype !== "bot_message") continue;
				if (!m.text) continue;
				if (m.bot_id || m.subtype === "bot_message") {
					out.push({
						ts: m.ts,
						userName: m.username || personaName(),
						avatarUrl: m.icons?.image_72 || m.icons?.image_48,
						text: prettifyMentions(m.text),
						isBot: true,
						replyCount: m.reply_count || 0,
					});
				} else if (m.user) {
					const u = await resolveSlackUser(m.user);
					out.push({
						ts: m.ts,
						userName: u.name,
						avatarUrl: u.avatarUrl,
						text: prettifyMentions(m.text),
						isBot: false,
						replyCount: m.reply_count || 0,
					});
				}
			}
			return Response.json({
				messages: out,
				hasMore: !!data.has_more,
				asUser: !!grantToken,
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "history failed" },
				{ status: 502 },
			);
		}
	}

	if (req.method === "POST") {
		const body = (await req.json().catch(() => null)) as {
			text?: string;
		} | null;
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		if (!text)
			return Response.json({ error: "text required" }, { status: 400 });
		if (!grantToken)
			return Response.json(
				{
					error:
						"Connect your Slack account in Settings → My accounts to post as yourself",
				},
				{ status: 403 },
			);
		try {
			const { slackApiCall } = await import("../../agents/slack/slack-api");
			const res = await slackApiCall(
				"chat.postMessage",
				{ channel: channelId, text },
				grantToken,
			);
			if (!res?.ok)
				return Response.json(
					{ error: res?.error || "post failed" },
					{ status: 502 },
				);
			return Response.json({ ok: true, ts: res.ts });
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "post failed" },
				{ status: 502 },
			);
		}
	}

	return undefined;
}
