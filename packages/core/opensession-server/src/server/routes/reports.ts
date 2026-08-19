/**
 * Reports routes: the Reports view's list/history/raw-HTML surface over the
 * reports store (src/server/reports.ts), plus the one write — starting a
 * session per task. Publishing itself happens through the opensession-report
 * MCP tool inside automation runs, never over HTTP.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
	getReport,
	listReportGroups,
	listReports,
	listReportsForSession,
	readReportAsset,
	readReportHtml,
	type ReportTask,
} from "../reports";
import { adaptReportHtml } from "../report-theme";
import { assetMime } from "../session-assets";
import { getAutomation } from "../automations";
import { getSessionControl } from "../session-control";
import { sanitizeBranchSlug } from "../suggest-branch";
import { resolveUniqueBranch } from "../worktree";

/**
 * The opening prompt for one task's session.
 *
 * The task prompt stands alone by contract, so all this adds is what the agent
 * cannot know from it. Two things, and both are load-bearing.
 *
 * That it is one of a batch: without it a session handed "fix the
 * reply_suggestions decoder" reads the report it came from and fixes six more
 * things, which is the single-big-branch outcome the fan-out exists to avoid.
 *
 * And that its worktree is the one to work in. A report is written by an agent
 * that ran somewhere else, and it will happily name that absolute path in a
 * task ("In /home/ubuntu/projects/opensession, implement…"). Followed
 * literally on a shared-checkout repo that lands every session back in the one
 * live checkout, which is precisely what the isolated worktree just bought.
 */
export function fanOutPrompt(
	task: ReportTask,
	report: { title: string; automationName: string },
	batchSize: number,
): string {
	const batch =
		batchSize > 1
			? ` It is one of ${batchSize} started together from that report, each in its own session and worktree: do this item only, leave the others alone even where the report describes them, and keep your commits scoped to this change.`
			: "";
	return `${task.prompt}

---
This task comes from the "${report.automationName}" report "${report.title}".${batch} Work in the checkout you are already in, which is yours alone. If the task text names an absolute path for this repository, ignore it and use your own worktree.`;
}

/** A stable, readable branch per task: `report-<slug of the title>`. */
async function branchForTask(task: ReportTask, repo?: string): Promise<string> {
	const slug = sanitizeBranchSlug(task.title) || "task";
	return await resolveUniqueBranch(`report-${slug}`, repo);
}

export async function handleReportsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;

	// Start one session per selected task, each in its own workspace on its own
	// isolated worktree. Sequential on purpose: every create takes the repo's
	// git lock to add a worktree, and a caller who just asked for twenty of
	// them gets a stampede otherwise. Partial failure is reported per task
	// rather than failing the batch — nineteen started sessions should not be
	// thrown away because one branch name collided.
	const fanOut = path.match(/^\/api\/reports\/([^/]+)\/([^/]+)\/sessions$/);
	if (fanOut && req.method === "POST") {
		const automationId = decodeURIComponent(fanOut[1]);
		const reportId = decodeURIComponent(fanOut[2]);
		const report = getReport(automationId, reportId);
		if (!report) return Response.json({ error: "No such report" }, { status: 404 });
		const tasks = report.tasks || [];
		if (!tasks.length)
			return Response.json(
				{ error: "This report proposes no tasks" },
				{ status: 400 },
			);
		const body = (await req.json().catch(() => null)) as {
			tasks?: unknown;
			user?: unknown;
		} | null;
		// Indexes into the report's own task list, so the client can never
		// invent work: the prompt an agent receives is the published one.
		const wanted = Array.isArray(body?.tasks)
			? [...new Set(body.tasks.filter((i): i is number => Number.isInteger(i)))]
					.filter((i) => i >= 0 && i < tasks.length)
					.sort((a, b) => a - b)
			: tasks.map((_, i) => i);
		if (!wanted.length)
			return Response.json({ error: "No tasks selected" }, { status: 400 });
		const repo = getAutomation(automationId)?.repo;
		const user = requestUser(ctx, body?.user);
		const started: Array<{
			task: number;
			title: string;
			id?: string;
			error?: string;
		}> = [];
		console.log(
			`[reports] fan-out: ${wanted.length} session(s) from "${report.title}" (repo ${repo || "default"})`,
		);
		for (const index of wanted) {
			const task = tasks[index];
			const startedAt = Date.now();
			try {
				const branch = await branchForTask(task, repo);
				console.log(`[reports] fan-out: creating ${branch}`);
				const { id } = await getSessionControl().createSession({
					prompt: fanOutPrompt(task, report, wanted.length),
					mode: "code",
					branch,
					// The whole point of the batch: one workspace each, and on a
					// shared-checkout repo that needs asking for.
					isolatedWorktree: true,
					...(repo ? { repo } : {}),
					...(user ? { user } : {}),
				});
				console.log(
					`[reports] fan-out: ${branch} → ${id} in ${Date.now() - startedAt}ms`,
				);
				started.push({ task: index, title: task.title, id });
			} catch (e) {
				console.warn(
					`[reports] fan-out: task ${index} failed after ${Date.now() - startedAt}ms:`,
					e,
				);
				started.push({
					task: index,
					title: task.title,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		return Response.json({ sessions: started });
	}

	if (req.method !== "GET") return undefined;

	// One row per automation that has published reports (latest + count).
	if (path === "/api/reports") {
		return Response.json({ groups: listReportGroups() });
	}

	// The reports published by one run, powering its right-sidebar Reports tab.
	const sessionMatch = path.match(
		/^\/api\/reports\/session\/([^/]+)$/,
	);
	if (sessionMatch) {
		return Response.json({
			reports: listReportsForSession(decodeURIComponent(sessionMatch[1])),
		});
	}

	// The rendered report itself — served as a document for the detail iframe.
	// `sandbox` keeps agent-authored HTML inert (no scripts, no top navigation)
	// while allow-same-origin lets it be styled/read normally.
	//
	// `?theme=dark` asks for the document in the app's dark scheme. Because the
	// report cannot run scripts, that has to happen here: adaptReportHtml
	// (src/server/report-theme.ts) serves it already dark rather than letting a
	// white page paint first and be corrected afterwards. Without the parameter
	// the response is the document as the agent published it.
	const rawMatch = path.match(
		/^\/api\/reports\/([^/]+)\/([^/]+)\/raw$/,
	);
	if (rawMatch) {
		const stored = readReportHtml(
			decodeURIComponent(rawMatch[1]),
			decodeURIComponent(rawMatch[2]),
		);
		if (stored === null)
			return new Response("Report not found", { status: 404 });
		const html = adaptReportHtml(
			stored,
			ctx.url.searchParams.get("theme") === "dark" ? "dark" : "light",
		);
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox allow-same-origin",
			},
		});
	}

	// Durable files referenced by report HTML as assets/<path>.
	const assetMatch = path.match(
		/^\/api\/reports\/([^/]+)\/([^/]+)\/assets\/(.+)$/,
	);
	if (assetMatch) {
		const asset = readReportAsset(
			decodeURIComponent(assetMatch[1]),
			decodeURIComponent(assetMatch[2]),
			decodeURIComponent(assetMatch[3]),
		);
		if (!asset) return new Response("Report asset not found", { status: 404 });
		const file = Bun.file(asset.path);
		return new Response(file, {
			headers: {
				"Content-Type": assetMime(asset.rel),
				"Content-Length": String(file.size),
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}

	// A group's history, newest first.
	const groupMatch = path.match(/^\/api\/reports\/([^/]+)$/);
	if (groupMatch) {
		return Response.json({
			reports: listReports(decodeURIComponent(groupMatch[1])),
		});
	}

	return undefined;
}
