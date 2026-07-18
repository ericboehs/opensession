/**
 * opensession-search — in-process MCP server over the session history index
 * (src/server/session-index.ts): distilled records of past sessions, searched
 * lexically (FTS5 bm25) with recency decay. Read-only, one tool.
 *
 * INTERACTIVE RUNS ONLY. Past-session records can contain customer and
 * internal material, so this must never reach automation runs processing
 * untrusted event/ticket text — the run-rpc builder's automation gate
 * (interactive-mcp.ts) fails closed, same as the sessions/admin siblings.
 * Never add write or control tools here.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { searchSessionHistory, searchIndex } from "../../server/session-index";

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

export function createSearchMcpServer() {
	const tools = [
		tool(
			"search_history",
			"Search past OpenSession sessions (distilled question/resolution records, lexical match + recency-weighted). Use BEFORE re-deriving something that has likely been solved here before: a bug that looks familiar, an error string, 'how did we fix/decide X', which session touched a file or subsystem. Exact tokens work best — error fragments, file names, function names, flag names. Results include the session id; read the full story with opensession-sessions get_session.",
			{
				query: z
					.string()
					.describe(
						"Search terms. Prefer concrete tokens (error strings, file/function names) over prose.",
					),
				repo: z
					.string()
					.optional()
					.describe("Only sessions whose primary repo is this id (e.g. 'backstage', 'tella-fusion')."),
				days: z
					.number()
					.optional()
					.describe("Only sessions active in the last N days."),
				limit: z.number().optional().describe("Max results (default 8, max 25)."),
			},
			async (args: { query: string; repo?: string; days?: number; limit?: number }) => {
				try {
					const hits = searchSessionHistory(args.query, {
						repo: args.repo,
						days: args.days,
						limit: args.limit,
					});
					if (!hits.length) {
						return text(
							`No matches${args.repo ? ` in ${args.repo}` : ""} for "${args.query}" (index holds ${searchIndex().count()} sessions). Try fewer or different tokens.`,
						);
					}
					const lines = hits.map((h, i) => {
						const id = h.id.replace(/^session:/, "");
						const date = new Date(h.ts).toISOString().slice(0, 10);
						const parts = [
							`${i + 1}. [${date}]${h.repo ? ` (${h.repo})` : ""}${h.user ? ` ${h.user}:` : ""} ${h.question}`,
						];
						if (h.resolution) parts.push(`   → ${h.resolution}`);
						if (h.files) parts.push(`   files: ${h.files.split(/\s+/).slice(0, 8).join(" ")}`);
						parts.push(`   session: ${id}${h.pr ? `  PR: ${h.pr}` : ""}`);
						return parts.join("\n");
					});
					lines.push(
						"\nFor the full transcript of a hit, use opensession-sessions get_session with the session id.",
					);
					return text(lines.join("\n"));
				} catch (e: any) {
					return text(`Search failed: ${e?.message || String(e)}`);
				}
			},
		),
	];

	return createSdkMcpServer({ name: "opensession-search", version: "1.0.0", tools });
}
