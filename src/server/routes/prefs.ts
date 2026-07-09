/**
 * Per-user/system preferences: Web Push, session monitor, auto-archive, warm preview templates, memory stores, pinned tabs, tab colors.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { getAutoArchiveConfig, setAutoArchiveConfig } from "../auto-archive";
import { frontend } from "../frontend-build";
import { getPins as getUserPins, setPins as setUserPins } from "../pins";
import { addSessionMemory, describeScope, forgetSessionMemory, listAllMemory, updateMemoryEntry } from "../session-memory";
import { getTabColors as getUserTabColors, setTabColors as setUserTabColors } from "../tab-colors";
import { refreshWarmTemplate, setWarmTemplateConfig, warmTemplateStatus } from "../warm-template";
import { REPOS } from "../worktree";

export async function handlePrefsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Web Push (phone/desktop notifications, app closed) ──
	if (path === "/backstage/api/push/vapid-key" && req.method === "GET") {
		const { getVapidPublicKey } = await import("../../server/push");
		return Response.json({ publicKey: getVapidPublicKey() });
	}

	if (path === "/backstage/api/push/subscribe" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const { addPushSubscription } = await import("../../server/push");
		const result = addPushSubscription({
			user: body.user,
			subscription: body.subscription,
			userAgent: req.headers.get("user-agent") || undefined,
		});
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (path === "/backstage/api/push/unsubscribe" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.endpoint !== "string")
			return Response.json({ error: "endpoint required" }, { status: 400 });
		const { removePushSubscription } = await import("../../server/push");
		removePushSubscription(body.endpoint);
		return Response.json({ ok: true });
	}

	// ── Session monitor (per-user, opt-in) ──
	if (path === "/backstage/api/monitor" && req.method === "GET") {
		const user = (url.searchParams.get("user") || "").trim();
		if (!user)
			return Response.json({ error: "user required" }, { status: 400 });
		const { getMonitorConfig } = await import(
			"../../agents/loops/session-monitor"
		);
		return Response.json(getMonitorConfig(user));
	}

	if (path === "/backstage/api/monitor" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.user !== "string" || !body.user.trim())
			return Response.json({ error: "user required" }, { status: 400 });
		const { setMonitorConfig } = await import(
			"../../agents/loops/session-monitor"
		);
		return Response.json(setMonitorConfig(body.user, body));
	}

	// ── Auto-archive (per-user, opt-in by repo) ──
	if (path === "/backstage/api/auto-archive" && req.method === "GET") {
		const user = (url.searchParams.get("user") || "").trim();
		if (!user)
			return Response.json({ error: "user required" }, { status: 400 });
		return Response.json({
			...getAutoArchiveConfig(user),
			availableRepos: Object.keys(REPOS),
		});
	}

	if (path === "/backstage/api/auto-archive" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.user !== "string" || !body.user.trim())
			return Response.json({ error: "user required" }, { status: 400 });
		return Response.json(setAutoArchiveConfig(body.user, body));
	}

	// ── Warm preview templates (per-repo prebuilt worktrees, scheduled) ──
	if (path === "/backstage/api/warm-templates" && req.method === "GET") {
		return Response.json({ repos: warmTemplateStatus() });
	}

	{
		const m = path.match(
			/^\/backstage\/api\/warm-templates\/([^/]+)(\/refresh)?$/,
		);
		if (m) {
			const repoId = decodeURIComponent(m[1]);
			if (!(repoId in REPOS))
				return Response.json(
					{ error: `unknown repo "${repoId}"` },
					{ status: 404 },
				);
			if (!m[2] && req.method === "PUT") {
				const body = await req.json().catch(() => null);
				if (!body)
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				const patch: Record<string, unknown> = {};
				if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
				if (
					typeof body.intervalHours === "number" &&
					body.intervalHours >= 1
				)
					patch.intervalHours = Math.floor(body.intervalHours);
				if (Array.isArray(body.warmRoutes))
					patch.warmRoutes = body.warmRoutes.filter(
						(r: unknown): r is string => typeof r === "string",
					);
				setWarmTemplateConfig(repoId, patch);
				return Response.json({ repos: warmTemplateStatus() });
			}
			if (m[2] && req.method === "POST") {
				// Fire-and-forget: a refresh boots a real dev server (minutes);
				// the UI polls GET for progress via `refreshing`.
				void refreshWarmTemplate(repoId, { force: true }).catch(() => {});
				return Response.json({ repos: warmTemplateStatus() });
			}
		}
	}

	// ── Memory (Settings → Memory: the same repo/user/team/channel stores
	// the opensession-memory tools + Slack channel memory read/write) ──
	if (path === "/backstage/api/memory") {
		if (req.method === "GET") {
			return Response.json({
				scopes: await listAllMemory(Object.keys(REPOS)),
			});
		}
		const body = await req.json().catch(() => null);
		const scope = body?.scopeKey ? describeScope(String(body.scopeKey)) : null;
		if (!scope)
			return Response.json(
				{ error: "unknown or invalid scopeKey" },
				{ status: 400 },
			);
		if (req.method === "POST") {
			const text = String(body?.text || "").trim();
			if (!text)
				return Response.json({ error: "text required" }, { status: 400 });
			const entry = await addSessionMemory(
				scope,
				text,
				String(body?.by || "settings"),
			);
			return Response.json({ entry });
		}
		if (req.method === "PUT") {
			const text = String(body?.text || "").trim();
			if (!text || !body?.id)
				return Response.json(
					{ error: "id and text required" },
					{ status: 400 },
				);
			const entry = await updateMemoryEntry(scope.key, String(body.id), text);
			if (!entry)
				return Response.json({ error: "entry not found" }, { status: 404 });
			return Response.json({ entry });
		}
		if (req.method === "DELETE") {
			if (!body?.id)
				return Response.json({ error: "id required" }, { status: 400 });
			const res = await forgetSessionMemory([scope], String(body.id));
			if (!res.ok)
				return Response.json({ error: res.error }, { status: 404 });
			return Response.json({ ok: true });
		}
	}

	// ── Per-user pinned tabs ──
	// Keyed on the self-selected `user` name (team-internal, not auth). GET reads
	// a user's pins; PUT replaces them wholesale (the frontend sends the full list
	// on every toggle and on first-load localStorage migration).
	if (path === "/backstage/api/pins" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ pins: getUserPins(user) });
	}

	if (path === "/backstage/api/pins" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			!Array.isArray(body.pins)
		) {
			return Response.json(
				{ error: "user (string) and pins (array) are required" },
				{ status: 400 },
			);
		}
		return Response.json({ pins: setUserPins(body.user, body.pins) });
	}

	// ── Per-user session tab colors ──
	// Same per-user model as pins: GET reads a user's tab colors; PUT replaces
	// the whole map (the frontend sends the full map on every color change).
	if (path === "/backstage/api/tab-colors" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		return Response.json({ colors: getUserTabColors(user) });
	}

	if (path === "/backstage/api/tab-colors" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (
			!body ||
			typeof body.user !== "string" ||
			typeof body.colors !== "object" ||
			body.colors === null
		) {
			return Response.json(
				{ error: "user (string) and colors (object) are required" },
				{ status: 400 },
			);
		}
		return Response.json({
			colors: setUserTabColors(body.user, body.colors),
		});
	}

	return undefined;
}
