/**
 * Native team chat (watercooler + per-session tabs): messages, image uploads, reactions.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { broadcastToAll } from "../ws-hub";

export async function handleChatRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Team chat (native Backstage chat, unrelated to Slack). Channels:
	// "watercooler" (team-wide) and "session:<id>" (per-session Chat tab). ──
	if (path === "/backstage/api/chat/messages" && req.method === "GET") {
		const { getChatMessages, isValidChatChannel } = await import(
			"../../server/chat"
		);
		const channel = url.searchParams.get("channel") || "watercooler";
		if (!isValidChatChannel(channel))
			return Response.json({ error: "invalid channel" }, { status: 400 });
		const limit = Number(url.searchParams.get("limit")) || 200;
		return Response.json({ messages: getChatMessages(channel, limit) });
	}

	// Latest note per session channel — drives the sidebar's unread-note dots.
	if (path === "/backstage/api/chat/session-activity" && req.method === "GET") {
		const { sessionNoteActivity } = await import("../../server/chat");
		return Response.json({ channels: sessionNoteActivity() });
	}

	// Upload an image for a chat message. Streams the body to permanent
	// per-image storage (not the transient session-upload staging dir) and
	// returns its {id,name,mime} ref, which the client attaches to the message.
	if (path === "/backstage/api/chat/upload" && req.method === "POST") {
		try {
			const { saveChatImage } = await import("../../server/chat");
			const name = decodeURIComponent(
				req.headers.get("x-file-name") || "image",
			);
			const mime = req.headers.get("content-type") || "";
			const bytes = new Uint8Array(await req.arrayBuffer());
			const img = saveChatImage(bytes, name, mime);
			return Response.json({ ok: true, ...img });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String((e as Error)?.message || e) },
				{ status: 400 },
			);
		}
	}

	// Serve a stored chat image by id (Content-Type from its sidecar).
	const chatImgMatch = path.match(
		/^\/backstage\/api\/chat\/image\/([0-9a-fA-F-]{36})$/,
	);
	if (chatImgMatch && req.method === "GET") {
		const { getChatImage } = await import("../../server/chat");
		const img = getChatImage(chatImgMatch[1]);
		if (!img) return new Response("not found", { status: 404 });
		return new Response(Bun.file(img.path), {
			headers: {
				"content-type": img.mime,
				"cache-control": "public, max-age=31536000, immutable",
				"x-content-type-options": "nosniff",
			},
		});
	}

	if (path === "/backstage/api/chat/messages" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const user = requestUser(ctx, body?.user);
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const images = Array.isArray(body?.images) ? body.images : [];
		const channel =
			typeof body?.channel === "string" ? body.channel : "watercooler";
		const { addChatMessage, mentionedUsers, isValidChatChannel } =
			await import("../../server/chat");
		// A message needs either text or at least one image.
		if (!user || (!text && images.length === 0))
			return Response.json(
				{ error: "user and text or image required" },
				{ status: 400 },
			);
		if (!isValidChatChannel(channel))
			return Response.json({ error: "invalid channel" }, { status: 400 });
		const message = addChatMessage(channel, user, text, images, {
			threadId: body?.threadId,
			replyTo: body?.replyTo,
		});
		// null = nothing to store (no text + no image that landed on disk).
		if (!message)
			return Response.json(
				{ error: "user and text or image required" },
				{ status: 400 },
			);
		// Everyone gets it live — clients not viewing this channel use the
		// same event to bump unread badges.
		broadcastToAll({ type: "chat_message", channel, message });
		// @-mentions ping the tagged teammate's devices (works app-closed).
		const { sendPushToUser } = await import("../../server/push");
		const inSession = channel.startsWith("session:");
		const chatUrl = inSession
			? `/backstage/session/${encodeURIComponent(channel.slice("session:".length))}`
			: "/backstage/watercooler";
		const preview = text.length > 140 ? `${text.slice(0, 139)}…` : text;
		const mentioned = mentionedUsers(text, user);
		for (const name of mentioned) {
			void sendPushToUser(name, {
				title: inSession
					? `${user} mentioned you in a session chat`
					: `${user} mentioned you in the Watercooler`,
				body: preview,
				url: chatUrl,
				tag: `backstage-chat-${channel}`,
			});
		}
		// A thread reply also pings earlier thread participants (parent
		// author + repliers) — Slack semantics; explicit mentions above
		// already covered anyone tagged, so skip those.
		if (message.threadId) {
			const { threadUsers } = await import("../../server/chat");
			const already = new Set(mentioned.map((n) => n.toLowerCase()));
			for (const name of threadUsers(channel, message.threadId)) {
				if (name.toLowerCase() === user.trim().toLowerCase()) continue;
				if (already.has(name.toLowerCase())) continue;
				void sendPushToUser(name, {
					title: inSession
						? `${user} replied in a session chat thread`
						: `${user} replied in a Watercooler thread`,
					body: preview || "🖼️ image",
					url: chatUrl,
					tag: `backstage-chat-${channel}`,
				});
			}
		}
		return Response.json({ message });
	}

	// Toggle an emoji reaction on a chat message. The updated message fans
	// out to every client (same broadcast pattern as new messages).
	if (path === "/backstage/api/chat/react" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const user = requestUser(ctx, body?.user);
		const messageId =
			typeof body?.messageId === "string" ? body.messageId : "";
		const emoji = typeof body?.emoji === "string" ? body.emoji : "";
		const channel =
			typeof body?.channel === "string" ? body.channel : "watercooler";
		const { toggleChatReaction, isValidChatChannel } = await import(
			"../../server/chat"
		);
		if (!isValidChatChannel(channel) || !user || !messageId || !emoji)
			return Response.json({ error: "invalid reaction" }, { status: 400 });
		const message = toggleChatReaction(channel, messageId, emoji, user);
		if (!message)
			return Response.json({ error: "message not found" }, { status: 404 });
		broadcastToAll({ type: "chat_message_updated", channel, message });
		return Response.json({ message });
	}

	return undefined;
}
