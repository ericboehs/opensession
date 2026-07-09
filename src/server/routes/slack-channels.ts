/**
 * Linked Slack channels: link/create, unlink, history, and posting as a teammate.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { fetchChannelHistory, getChannelName, postChannelMessageAs, resolveSlackUser } from "../../agents/slack/slack-api";
import { createSlackChannel, findSlackChannel, inviteBotToChannel, setChannelTopic } from "../../agents/slack/worktree-channels";
import { findSession, touchBackstageSession } from "../session-cache";
import { resolveTeammate } from "../shared/user-mappings";
import { linkInIndex, sessionForChannel, unlinkInIndex } from "../slack-links";
import { broadcastToAll, broadcastToSession } from "../ws-hub";

export async function handleSlackChannelsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Linked Slack channels ──
	// Link (or create) a Slack channel for a session so the team can discuss it
	// in context; strictly one channel ↔ one session.
	const linkChanMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/link-channel$/,
	);
	if (linkChanMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(linkChanMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			mode?: "create" | "existing";
			name?: string;
			channelId?: string;
		};
		try {
			let channelId: string | undefined;
			let name: string | undefined;
			if (body.mode === "create") {
				const slug =
					(body.name || session.title || "session")
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-+|-+$/g, "")
						.slice(0, 60) || "session";
				const chanName = `michael-${slug}`.slice(0, 80);
				const res = await createSlackChannel(chanName);
				if (!res.ok || !res.channelId)
					return Response.json(
						{ error: res.error || "Could not create channel" },
						{ status: 400 },
					);
				channelId = res.channelId;
				await inviteBotToChannel(channelId);
				await setChannelTopic(channelId, session.title || "Michael session");
				name = (await getChannelName(channelId)) || chanName;
			} else {
				const ref = (body.channelId || body.name || "")
					.trim()
					.replace(/^#/, "");
				if (!ref)
					return Response.json(
						{ error: "channelId or name required" },
						{ status: 400 },
					);
				channelId = /^C[A-Z0-9]+$/i.test(ref)
					? ref
					: (await findSlackChannel(ref)) || undefined;
				if (!channelId)
					return Response.json(
						{ error: "Channel not found" },
						{ status: 404 },
					);
				await inviteBotToChannel(channelId);
				name = (await getChannelName(channelId)) || ref;
			}
			if (!channelId)
				return Response.json(
					{ error: "Could not resolve channel" },
					{ status: 400 },
				);
			// Enforce strictly one-to-one.
			const owner = sessionForChannel(channelId);
			if (owner && owner !== sessionId)
				return Response.json(
					{ error: "That channel is already linked to another session" },
					{ status: 409 },
				);
			const slackChannel = { channelId, name };
			touchBackstageSession(sessionId, { slackChannel });
			linkInIndex(sessionId, channelId);
			broadcastToSession(sessionId, {
				type: "channel_linked",
				sessionId,
				slackChannel,
			});
			return Response.json({ ok: true, slackChannel });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	const unlinkChanMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/unlink-channel$/,
	);
	if (unlinkChanMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(unlinkChanMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		touchBackstageSession(sessionId, { slackChannel: undefined });
		unlinkInIndex(sessionId);
		broadcastToSession(sessionId, {
			type: "channel_linked",
			sessionId,
			slackChannel: null,
		});
		return Response.json({ ok: true });
	}

	const chanHistMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/channel\/history$/,
	);
	if (chanHistMatch && req.method === "GET") {
		const sessionId = decodeURIComponent(chanHistMatch[1]);
		const session = findSession(sessionId);
		const channelId = session?.slackChannel?.channelId;
		if (!channelId) return Response.json({ messages: [] });
		const messages = await fetchChannelHistory(channelId, 60);
		return Response.json({ messages });
	}

	const chanMsgMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/channel\/message$/,
	);
	if (chanMsgMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(chanMsgMatch[1]);
		const session = findSession(sessionId);
		const channelId = session?.slackChannel?.channelId;
		if (!channelId)
			return Response.json(
				{ error: "No linked channel" },
				{ status: 400 },
			);
		const body = (await req.json().catch(() => ({}))) as {
			text?: string;
			user?: string;
		};
		const rawText = (body.text || "").trim();
		if (!rawText)
			return Response.json({ error: "text required" }, { status: 400 });
		// Tag people: turn "@Name" tokens into real Slack <@id> mentions so the
		// person is pinged. Unknown names are left as plain text.
		const text = rawText.replace(/@([A-Za-z][\w-]*)/g, (whole, nm) => {
			const t = resolveTeammate(nm);
			return t ? `<@${t.slackId}>` : whole;
		});
		// Post as the sender (name + avatar) when we can resolve them.
		const teammate = resolveTeammate(body.user);
		let username = teammate?.name || body.user || "Anonymous";
		let avatarUrl: string | undefined;
		if (teammate) {
			const u = await resolveSlackUser(teammate.slackId);
			username = u.name;
			avatarUrl = u.avatarUrl;
		}
		const res = await postChannelMessageAs(channelId, text, {
			username,
			iconUrl: avatarUrl,
		});
		if (!res.ok)
			return Response.json(
				{ error: "Slack post failed" },
				{ status: 502 },
			);
		const message = {
			ts: res.ts || String(Date.now() / 1000),
			userId: teammate?.slackId || null,
			userName: username,
			avatarUrl,
			text: rawText,
			isBot: !res.overridden,
		};
		// Our bot post is dropped by /slack/events, so echo it to every client.
		broadcastToAll({ type: "slack_message", channelId, message });
		return Response.json({ ok: true, message });
	}

	return undefined;
}
