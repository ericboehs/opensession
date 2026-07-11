/**
 * HQ config + session routes (see src/server/hq.ts for the feature).
 *
 *   GET  /backstage/api/hq?user=…  → config + buffered count + subscribable
 *                                    event types + enabled automations (for
 *                                    the per-automation toggles)
 *   PUT  /backstage/api/hq         → merge-patch {user, status?, workHours?,
 *                                    digestMinutes?, subs?}
 *   POST /backstage/api/hq/ensure  → get-or-create the user's HQ session
 *
 * Every handler returns a Response for a matched route or undefined to fall
 * through (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import {
	ensureHqSession,
	getHqInfo,
	HQ_EVENT_TYPES,
	patchHqConfig,
} from "../hq";
import { findSession } from "../session-cache";

export async function handleHqRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path } = ctx;

	if (path === "/backstage/api/hq" && req.method === "GET") {
		const user = (url.searchParams.get("user") || "").trim();
		if (!user)
			return Response.json({ error: "user required" }, { status: 400 });
		const { listAutomations } = await import("../automations");
		return Response.json({
			...getHqInfo(user),
			eventTypes: HQ_EVENT_TYPES,
			automations: listAutomations()
				.filter((a) => a.enabled)
				.map((a) => ({ id: a.id, name: a.name })),
		});
	}

	if (path === "/backstage/api/hq" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.user !== "string" || !body.user.trim())
			return Response.json({ error: "user required" }, { status: 400 });
		return Response.json(patchHqConfig(body.user.trim(), body));
	}

	if (path === "/backstage/api/hq/ensure" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.user !== "string" || !body.user.trim())
			return Response.json({ error: "user required" }, { status: 400 });
		const { sessionId } = ensureHqSession(body.user.trim());
		return Response.json({
			sessionId,
			session: findSession(sessionId) ?? null,
		});
	}

	return undefined;
}
