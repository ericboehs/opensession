/**
 * Workflow routes: read access to dynamic-workflow runs
 * (~/.opensession-workflows via workflow-store.ts) for the session viewer's
 * Agents panel, plus cancel. Runs are created through the
 * opensession-workflows MCP tools (workflow-tools.ts), never over HTTP.
 */

import type { RouteContext } from "./context";
import type { WorkflowJournalEntry } from "../workflow-types";
import {
	getWorkflowRun,
	listWorkflowRunsForSession,
	markInterruptedWorkflows,
	readWorkflowJournal,
} from "../workflow-store";
import { cancelWorkflow } from "../workflow-runner";
import { readEngineTranscript } from "../sessions";

// Boot pass: flip any run.json still "running" with no live worker to
// "interrupted" (the orchestration state died with the previous process).
// routes/index.ts is imported once at boot, which gives us this hook without
// touching opensession.ts; the globalThis flag keeps hot reloads (which
// re-import this module) from re-running it while workflows are live.
if (!(globalThis as any).__opensessionWorkflowsBootMarked) {
	(globalThis as any).__opensessionWorkflowsBootMarked = true;
	try {
		markInterruptedWorkflows();
	} catch (e) {
		console.warn("[workflow] boot interrupted-run pass failed:", e);
	}
}

export async function handleWorkflowsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	// All workflow runs for a session (newest first) — the Agents panel's
	// initial load; live updates arrive as workflow_update WS messages.
	{
		const m = path.match(/^\/backstage\/api\/sessions\/([^/]+)\/workflows$/);
		if (m && req.method === "GET") {
			return Response.json({
				runs: listWorkflowRunsForSession(decodeURIComponent(m[1])),
			});
		}
	}

	// One agent's full conversation (its opencode session transcript — tool
	// calls and all) — the "go into the subagent" drill-in. Reads the live
	// snapshot first (engineSessionId is set the moment the engine session
	// exists, so this works WHILE the agent runs), falling back to the journal
	// outcome for a finished agent. Capped so a chatty agent can't blow the
	// payload.
	{
		const m = path.match(
			/^\/backstage\/api\/workflows\/([^/]+)\/agents\/(\d+)\/transcript$/,
		);
		if (m && req.method === "GET") {
			const runId = decodeURIComponent(m[1]);
			const seq = parseInt(m[2], 10);
			const run = getWorkflowRun(runId);
			if (!run)
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			const snap = run.agents.find((a) => a.seq === seq);
			const journal = readWorkflowJournal(runId).find(
				(e: WorkflowJournalEntry) => e.seq === seq,
			);
			const engineSessionId =
				snap?.engineSessionId || journal?.outcome.engineSessionId;
			const cwd = journal?.outcome.cwd || run.cwd;
			if (!engineSessionId)
				return Response.json(
					{ error: "Agent has not started a run yet", entries: [] },
					{ status: 404 },
				);
			let entries = readEngineTranscript(cwd, engineSessionId, "opencode");
			if (entries.length > 500) entries = entries.slice(-500);
			return Response.json({ entries });
		}
	}

	// One agent call's journal entry (full prompt + outcome, not the snapshot
	// previews) — the panel's drill-in.
	{
		const m = path.match(
			/^\/backstage\/api\/workflows\/([^/]+)\/agents\/(\d+)$/,
		);
		if (m && req.method === "GET") {
			const runId = decodeURIComponent(m[1]);
			const seq = parseInt(m[2], 10);
			if (!getWorkflowRun(runId))
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			const entry = readWorkflowJournal(runId).find(
				(e: WorkflowJournalEntry) => e.seq === seq,
			);
			if (!entry)
				return Response.json(
					{ error: "No journal entry for that agent (still running?)" },
					{ status: 404 },
				);
			return Response.json(entry);
		}
	}

	{
		const m = path.match(/^\/backstage\/api\/workflows\/([^/]+)\/cancel$/);
		if (m && req.method === "POST") {
			return Response.json({ ok: cancelWorkflow(decodeURIComponent(m[1])) });
		}
	}

	// Full run snapshot. Keep this last in the family — it's the loosest match.
	{
		const m = path.match(/^\/backstage\/api\/workflows\/([^/]+)$/);
		if (m && req.method === "GET") {
			const run = getWorkflowRun(decodeURIComponent(m[1]));
			if (!run)
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			return Response.json(run);
		}
	}

	return undefined;
}
