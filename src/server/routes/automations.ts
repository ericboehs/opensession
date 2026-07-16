/**
 * Automation CRUD/run, templates, AI-drafted configs, and scheduled prompts.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { AUTOMATION_TEMPLATES } from "../automation-templates";
import { createAutomation, deleteAutomation, getAutomation, isAutomationRunning, listAutomations, retriggerAutomationSession, runAutomation, updateAutomation } from "../automations";
import { draftAutomation } from "../draft-automation";
import { invalidateSessionsCache } from "../session-cache";

export async function handleAutomationsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Automations ──
	if (path === "/backstage/api/automation-templates" && req.method === "GET") {
		return Response.json(AUTOMATION_TEMPLATES);
	}

	// Draft an automation config from a free-text description (one-shot
	// Haiku; the draft only pre-fills the form, it's never saved directly).
	if (path === "/backstage/api/automations/draft" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.description !== "string")
			return Response.json({ error: "description required" }, { status: 400 });
		const draft = await draftAutomation(body.description);
		if (!draft)
			return Response.json(
				{ error: "Couldn't draft an automation from that — add more detail or fill the form manually" },
				{ status: 422 },
			);
		return Response.json(draft);
	}

	if (path === "/backstage/api/automations" && req.method === "GET") {
		const list = listAutomations().map((a) => ({
			...a,
			isRunning: isAutomationRunning(a.id),
		}));
		return Response.json(list);
	}

	if (path === "/backstage/api/automations" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const result = createAutomation(body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const autoRunMatch = path.match(
		/^\/backstage\/api\/automations\/([^/]+)\/run$/,
	);
	if (autoRunMatch && req.method === "POST") {
		const automation = getAutomation(autoRunMatch[1]);
		if (!automation)
			return Response.json({ error: "Not found" }, { status: 404 });
		if (isAutomationRunning(automation.id)) {
			return Response.json({ error: "Already running" }, { status: 409 });
		}
		// Fire and forget; session shows up in the list once it boots
		void runAutomation(automation, () => {
			invalidateSessionsCache();
		});
		return Response.json({ ok: true });
	}

	// Re-fire an automation with the original triggering event of one of its
	// past runs — the HTTP twin of the Slack thread-reply "retrigger". Body:
	// {sessionId} of the automation-owned session whose event to replay.
	if (path === "/backstage/api/automations/retrigger" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.sessionId !== "string")
			return Response.json({ error: "sessionId required" }, { status: 400 });
		const result = retriggerAutomationSession(body.sessionId);
		if (!result.ok) return Response.json({ error: result.reason }, { status: 400 });
		invalidateSessionsCache();
		return Response.json(result);
	}

	const autoMatch = path.match(/^\/backstage\/api\/automations\/([^/]+)$/);
	if (autoMatch && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const result = updateAutomation(autoMatch[1], body);
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	if (autoMatch && req.method === "DELETE") {
		return deleteAutomation(autoMatch[1])
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	// ── Scheduled prompts (composer "send later") ──
	const schedListMatch = path.match(
		/^\/backstage\/api\/sessions\/([^/]+)\/scheduled-prompts$/,
	);
	if (schedListMatch && req.method === "GET") {
		const { listScheduledPrompts } = await import(
			"../../server/scheduled-prompts"
		);
		return Response.json({
			prompts: listScheduledPrompts(schedListMatch[1]),
		});
	}

	if (schedListMatch && req.method === "POST") {
		const body = await req.json().catch(() => null);
		if (!body)
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		const { createScheduledPrompt } = await import(
			"../../server/scheduled-prompts"
		);
		const result = createScheduledPrompt({
			sessionId: schedListMatch[1],
			prompt: body.prompt,
			at: body.at,
			user: body.user,
		});
		if ("error" in result) return Response.json(result, { status: 400 });
		return Response.json(result);
	}

	const schedDelMatch = path.match(
		/^\/backstage\/api\/scheduled-prompts\/([^/]+)$/,
	);
	if (schedDelMatch && req.method === "DELETE") {
		const { deleteScheduledPrompt } = await import(
			"../../server/scheduled-prompts"
		);
		return deleteScheduledPrompt(schedDelMatch[1])
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	return undefined;
}
