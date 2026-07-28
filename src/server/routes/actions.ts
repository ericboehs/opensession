/**
 * Actions: registered repo scripts behind a form (CRUD, introspect, run).
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { createAction, deleteAction, getAction, introspectScript, listActions, runAction } from "../actions";
import { defaultRepo } from "../config";
import { invalidateSessionsCache } from "../session-cache";

export async function handleActionsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Actions (run a registered repo script behind a form) ──
	if (path === "/backstage/api/actions" && req.method === "GET") {
		return Response.json(listActions());
	}

	if (path === "/backstage/api/actions" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const result = createAction(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	// Suggest inputs for a script being registered (parses $1..$9 / $VAR).
	if (
		path === "/backstage/api/actions/introspect" &&
		req.method === "POST"
	) {
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
			scriptPath?: string;
		};
		const result = introspectScript(
			body.repo || defaultRepo().id,
			String(body.scriptPath || ""),
		);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const actionRunMatch = path.match(
		/^\/backstage\/api\/actions\/([^/]+)\/run$/,
	);
	if (actionRunMatch && req.method === "POST") {
		const action = getAction(actionRunMatch[1]);
		if (!action)
			return Response.json({ error: "Not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			values?: Record<string, unknown>;
			user?: string;
		};
		const result = runAction(action, body.values || {}, requestUser(ctx, body.user) || undefined, () => {
			invalidateSessionsCache();
		});
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const actionMatch = path.match(/^\/backstage\/api\/actions\/([^/]+)$/);
	if (actionMatch && req.method === "GET") {
		const action = getAction(actionMatch[1]);
		return action
			? Response.json(action)
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	if (actionMatch && req.method === "DELETE") {
		return deleteAction(actionMatch[1])
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	return undefined;
}
