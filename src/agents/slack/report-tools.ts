/**
 * opensession-report — publish_report: lets a run publish a self-contained
 * HTML report into the Reports store (~/.opensession-reports, see
 * src/server/reports.ts), grouped per automation and browsed in the frontend
 * Reports view (latest + history per automation).
 *
 * Wired into EVERY automation run (automations.ts), like the papercuts
 * sibling, and held to the same automation in-process bar: publish-only
 * (append into its own automation's group), nothing sensitive readable, no
 * control surface. The automation identity is baked in here — a run can never
 * publish into another automation's group.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { publishReport, MAX_REPORT_BYTES } from "../../server/reports";

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

export function createReportMcpServer(ctx: {
	automationId: string;
	automationName: string;
	sessionId?: string;
}) {
	const tools = [
		tool(
			"publish_report",
			"Publish this run's report: one SELF-CONTAINED HTML document (inline CSS, no external resources) shown in the Reports view — latest per automation, with history. Use it when the task's outcome is a recurring readable report (a digest, an analysis); each publish adds a new entry to this automation's history, so publish once per run with the final document. Not for ordinary task output or scratch artifacts.",
			{
				title: z
					.string()
					.describe(
						'Human title for this report, e.g. "Support digest — 2026-07-12".',
					),
				html: z
					.string()
					.describe(
						`The full HTML document (max ${Math.floor(MAX_REPORT_BYTES / 1024 / 1024)} MB). Self-contained: inline CSS, no external scripts/styles/images.`,
					),
				summary: z
					.string()
					.optional()
					.describe(
						"Short plain-text gist (1-3 sentences) shown in report lists.",
					),
			},
			async (args: { title: string; html: string; summary?: string }) => {
				try {
					const meta = publishReport({
						automationId: ctx.automationId,
						automationName: ctx.automationName,
						sessionId: ctx.sessionId,
						title: args.title,
						html: args.html,
						summary: args.summary,
					});
					return text(
						`Published report "${meta.title}" (${meta.id}). It's now the latest report for "${ctx.automationName}" in the Reports view.`,
					);
				} catch (e: any) {
					return text(`Failed to publish report: ${e?.message || e}`);
				}
			},
		),
	];
	return createSdkMcpServer({ name: "opensession-report", tools });
}
