/**
 * Reports routes: the Reports view's list/history/raw-HTML surface over the
 * reports store (src/server/reports.ts). Read-only — publishing happens
 * through the opensession-report MCP tool inside automation runs.
 */

import type { RouteContext } from "./context";
import {
	listReportGroups,
	listReports,
	readReportHtml,
} from "../reports";

export async function handleReportsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path } = ctx;
	if (req.method !== "GET") return undefined;

	// One row per automation that has published reports (latest + count).
	if (path === "/backstage/api/reports") {
		return Response.json({ groups: listReportGroups() });
	}

	// The rendered report itself — served as a document for the detail iframe.
	// `sandbox` keeps agent-authored HTML inert (no scripts, no top navigation)
	// while allow-same-origin lets it be styled/read normally.
	const rawMatch = path.match(
		/^\/backstage\/api\/reports\/([^/]+)\/([^/]+)\/raw$/,
	);
	if (rawMatch) {
		const html = readReportHtml(
			decodeURIComponent(rawMatch[1]),
			decodeURIComponent(rawMatch[2]),
		);
		if (html === null)
			return new Response("Report not found", { status: 404 });
		return new Response(html, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox allow-same-origin",
			},
		});
	}

	// A group's history, newest first.
	const groupMatch = path.match(/^\/backstage\/api\/reports\/([^/]+)$/);
	if (groupMatch) {
		return Response.json({
			reports: listReports(decodeURIComponent(groupMatch[1])),
		});
	}

	return undefined;
}
