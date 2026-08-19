/**
 * Workflow routes: read access to dynamic-workflow runs
 * (~/.opensession-workflows via workflow-store.ts) for the session viewer's
 * Agents panel, plus cancel. Runs are created through the
 * opensession-workflows MCP tools (workflow-tools.ts), never over HTTP.
 */

import type { RouteContext } from "./context";
import {
	isMcpJournalEntry,
	type WorkflowJournalEntry,
} from "../workflow-types";
import {
	getWorkflowRun,
	listWorkflowRunsForSession,
	markInterruptedWorkflows,
	readWorkflowJournal,
} from "../workflow-store";
import { cancelWorkflow } from "../workflow-runner";
import {
	getOpencodeTranscriptPath,
	readOpencodeTranscript,
} from "../opencode-transcript";
import { parseTranscriptAsync } from "../jsonl-parser";
import { existsSync } from "fs";

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

/** The journal's agent() records only. mcp.* records live in the same file
 *  under their own seq space, so every seq-keyed agent lookup goes through
 *  here — a raw find() can otherwise match an unrelated tool call. */
function agentJournalEntries(runId: string): WorkflowJournalEntry[] {
	return readWorkflowJournal(runId).filter(
		(e): e is WorkflowJournalEntry => !isMcpJournalEntry(e),
	);
}

export async function handleWorkflowsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	// All workflow runs for a session (newest first) — the Agents panel's
	// initial load; live updates arrive as workflow_update WS messages.
	{
		const m = path.match(/^\/api\/sessions\/([^/]+)\/workflows$/);
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
			/^\/api\/workflows\/([^/]+)\/agents\/(\d+)\/transcript$/,
		);
		if (m && req.method === "GET") {
			const runId = decodeURIComponent(m[1]);
			const seq = parseInt(m[2], 10);
			const run = getWorkflowRun(runId);
			if (!run)
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			const snap = run.agents.find((a) => a.seq === seq);
			// mcp.* records share journal.jsonl and number their own seq space,
			// so an agent lookup MUST skip them or it can match the wrong record.
			const journal = agentJournalEntries(runId).find((e) => e.seq === seq);
			const engineSessionId =
				snap?.engineSessionId || journal?.outcome.engineSessionId;
			if (!engineSessionId)
				return Response.json(
					{ error: "Agent has not started a run yet", entries: [] },
					{ status: 404 },
				);
			// Prefer the runner's mirror jsonl (keyed by the ocSessionId we
			// captured), exactly like mergedSessionTranscript — opencode's own db
			// keys the content under a directory-scoped id that differs from the
			// init id on the shared server, so a raw db read misses. DB is the
			// fallback for older sessions with no mirror file.
			const mirror = getOpencodeTranscriptPath(engineSessionId);
			let entries = existsSync(mirror)
				? await parseTranscriptAsync(mirror)
				: readOpencodeTranscript(engineSessionId);
			if (entries.length > 500) entries = entries.slice(-500);
			return Response.json({ entries });
		}
	}

	// One agent call's journal entry (full prompt + outcome, not the snapshot
	// previews) — the panel's drill-in.
	{
		const m = path.match(
			/^\/api\/workflows\/([^/]+)\/agents\/(\d+)$/,
		);
		if (m && req.method === "GET") {
			const runId = decodeURIComponent(m[1]);
			const seq = parseInt(m[2], 10);
			if (!getWorkflowRun(runId))
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			const entry = agentJournalEntries(runId).find((e) => e.seq === seq);
			if (!entry)
				return Response.json(
					{ error: "No journal entry for that agent (still running?)" },
					{ status: 404 },
				);
			return Response.json(entry);
		}
	}

	{
		const m = path.match(/^\/api\/workflows\/([^/]+)\/cancel$/);
		if (m && req.method === "POST") {
			return Response.json({ ok: cancelWorkflow(decodeURIComponent(m[1])) });
		}
	}

	// Full run snapshot. Keep this last in the family — it's the loosest match.
	{
		const m = path.match(/^\/api\/workflows\/([^/]+)$/);
		if (m && req.method === "GET") {
			const run = getWorkflowRun(decodeURIComponent(m[1]));
			if (!run)
				return Response.json({ error: "Workflow not found" }, { status: 404 });
			return Response.json(run);
		}
	}

	return undefined;
}
