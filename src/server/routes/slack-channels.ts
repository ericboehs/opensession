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

	// Slack markup → markdown-ish the pane can linkify: <url|label> →
	// [label](url), bare <url> → url, <!here>/<!channel> → @here/@channel,
	// <#C…|name> → #name. User mentions ride prettifyMentions.
	const renderSlackText = (raw: string, prettifyMentions: (t: string) => string) =>
		prettifyMentions(
			raw
				.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
				.replace(/<(https?:[^>]+)>/g, "$1")
				.replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "@$1")
				.replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1"),
		);
	const channelId = decodeURIComponent(msgsMatch[1]);
	const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
	const { mcpUserGrantToken } = await import("../mcp-oauth");
	const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;

	if (req.method === "GET") {
		// Newest page by default; `before=<ts>` pages older (exclusive), the
		// same shape the transcript's Load-history uses. `thread_ts=<ts>`
		// returns that thread's replies instead (parent excluded).
		const threadTs = url.searchParams.get("thread_ts") || undefined;
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
				threadTs ? "conversations.replies" : "conversations.history",
				{
					channel: channelId,
					limit,
					...(threadTs ? { ts: threadTs } : {}),
					...(before ? { latest: before, inclusive: false } : {}),
				},
				grantToken,
			);
			if (threadTs && Array.isArray(data?.messages))
				data.messages = data.messages.filter(
					(m: any) => m.ts !== threadTs,
				);
			if (!data?.ok)
				return Response.json(
					{ error: data?.error || "history failed" },
					{ status: 502 },
				);
			// history arrives newest-first (reverse to chronological); thread
			// replies arrive oldest-first already.
			const chronological = threadTs
				? [...(data.messages || [])]
				: [...(data.messages || [])].reverse();
			const out: unknown[] = [];
			for (const m of chronological) {
				if (m.type !== "message") continue;
				if (m.subtype && m.subtype !== "bot_message") continue;
				if (!m.text) continue;
				// User-first: app-relayed posts carry BOTH user and bot_id (a
				// person's own message via an app) — the person wins, otherwise
				// Michiel's posts render as the bot.
				if (m.user) {
					const u = await resolveSlackUser(m.user);
					out.push({
						ts: m.ts,
						userName: u.name,
						avatarUrl: u.avatarUrl,
						text: renderSlackText(m.text, prettifyMentions),
						isBot: false,
						replyCount: m.reply_count || 0,
					});
				} else {
					out.push({
						ts: m.ts,
						userName: m.username || personaName(),
						avatarUrl: m.icons?.image_72 || m.icons?.image_48,
						text: renderSlackText(m.text, prettifyMentions),
						isBot: true,
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
