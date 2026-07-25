/**
 * In-app notification inbox — the per-user record every sendPushToUser call
 * appends to (src/server/push.ts). The sidebar bell lists these; "seen" state
 * is client-local.
 */

import { requestUser, type RouteContext } from "./context";

export async function handleNotificationsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path } = ctx;

	if (path === "/backstage/api/notifications" && req.method === "GET") {
		const user = requestUser(ctx, url.searchParams.get("user"));
		if (!user) return Response.json({ items: [] });
		const { listNotifications } = await import("../../server/push");
		const limit = Number(url.searchParams.get("limit")) || 100;
		return Response.json({ items: listNotifications(user, limit) });
	}

	return undefined;
}
