/**
 * Feed routes: the sidebar's generic external-object bands (Tella videos;
 * eventually every feed — see docs/feeds-design.md). Read-only surface: the
 * descriptors say which bands exist, the items endpoint feeds one band.
 * Mutations stay on each source's own routes (e.g. /api/plain/*).
 */
import type { RouteContext } from "./context";
import {
	ensureFeedsRegistered,
	getFeedItems,
	listFeedDescriptors,
} from "../feeds";

export async function handleFeedsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	if (path === "/backstage/api/feeds" && req.method === "GET") {
		await ensureFeedsRegistered();
		return Response.json({ feeds: listFeedDescriptors() });
	}

	const itemsMatch = path.match(/^\/backstage\/api\/feeds\/([^/]+)\/items$/);
	if (itemsMatch && req.method === "GET") {
		await ensureFeedsRegistered();
		const feedId = decodeURIComponent(itemsMatch[1]);
		try {
			const items = await getFeedItems(feedId);
			if (!items)
				return Response.json({ error: "Unknown feed" }, { status: 404 });
			return Response.json({ items });
		} catch (e: any) {
			console.error(`[feeds] Items fetch failed for ${feedId}:`, e);
			return Response.json(
				{ error: e?.message || "Feed fetch failed" },
				{ status: 502 },
			);
		}
	}

	return undefined;
}
