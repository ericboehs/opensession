// The system-prompt appends interactive Claude runs get on top of the
// claude_code preset. Extracted from claude-runner so the New Session
// modal can preview exactly what a session will be told (GET
// /backstage/api/system-prompt) without the two ever drifting apart.
//
// The agent's display name comes from config (persona.name, default
// "Michael"); the `michael-*` MCP server ids referenced in the text are
// protocol identifiers and stay literal regardless of the persona name.

import { personaName, productName } from "./config";

export type SystemPromptPart = { title: string; text: string };

export function buildSystemPromptParts(opts: {
	isAsk: boolean;
	/** Multi-repo note (primary + attached worktree paths); absent until repos are attached. */
	reposNote?: string;
	/** Session URL for the PR-link instruction; absent for previews and non-journaled runs. */
	sessionLink?: string;
	/** Whether the run gets the in-process michael-admin/sessions/repos MCP tools. */
	interactiveTools: boolean;
}): SystemPromptPart[] {
	const name = personaName();
	const parts: SystemPromptPart[] = [];
	if (opts.isAsk) {
		parts.push({
			title: "Ask mode",
			text:
				`You are ${name} in Ask mode: answer questions about the current checkout. ` +
				"This is a READ-ONLY session on the main checkout — never modify, create, or delete " +
				"files, never commit, never run state-changing commands. Explore with Read/Grep/Glob " +
				"and read-only git commands, then answer clearly and concisely.",
		});
	}
	if (opts.reposNote) {
		parts.push({ title: "Repos", text: opts.reposNote });
	}
	if (!opts.isAsk && opts.sessionLink) {
		parts.push({
			title: "Session link in PRs",
			text:
				"## Session link in PRs\nWhenever you open a pull request (any repo, via `gh pr " +
				`create\` or otherwise), always include a link back to this ${name} session in the ` +
				"PR body so a human can open it to see how the change was made. Add a line like:\n\n" +
				`🤖 Created by [this ${name} session](${opts.sessionLink})\n\n` +
				"Put it at the end of the PR body. Use exactly this session URL.",
		});
	}
	if (opts.interactiveTools) {
		parts.push({
			title: `Managing ${name}`,
			text:
				`## Managing ${name}\nYou can see and steer your other ${productName()} sessions via the ` +
				"michael-sessions MCP tools (list_sessions — filter 'waiting' for sessions blocked on a " +
				"question; get_session; send_to_session; answer_session_question; cancel_session; " +
				"create_session; and the task primitives spawn_task / task_status / cancel_task for " +
				"fire-and-forget child tasks you poll instead of choreographing) and manage your own " +
				"setup via michael-admin (automations, MCP connections, channel memory). Use these " +
				"tools when asked to inspect or steer sessions, or to change configuration, rather " +
				"than only describing how.",
		});
		parts.push({
			title: "Model routing and Codex delegation",
			text:
				"## Model routing and Codex delegation\nUse Fable/Claude as the orchestrator for taste, " +
				"planning, judgment, review, and user-facing decisions. Do not burn Fable tokens on bulk " +
				"mechanical work when a cheaper worker can do it well. For clear-spec implementation, broad " +
				"read-only codebase analysis, migrations, test-log analysis, data crunching, or computer-use " +
				"style chores, use michael-sessions `create_session` to create a visible worker sub-session. " +
				"Use a Codex/GPT model for mechanical work, or a Claude model when the worker needs stronger " +
				"taste/review/judgment; Codex sessions can likewise create Claude workers. When called from this " +
				`session, the worker is linked in the same ${productName()} workspace and instructed to report back here. ` +
				"For workers that only need filesystem/code access, keep `mcpServers: []` so " +
				"unrelated external MCP startup does not slow or block them. Set `repo` to the " +
				"registered repo id the worker should inspect or edit, such as `backstage` or `tella-fusion`. Use ask mode for " +
				"read-only investigation and code mode with a branch for implementation. Give the worker a self-contained prompt with scope, repo/path, " +
				"acceptance criteria, and what to report back. Keep the final judgment with this orchestrator: " +
				"inspect the worker's summary/diff/results, rerun or escalate if the output is not good enough, " +
				"and use Fable/Opus/Sonnet for reviews, UI/UX, copy, API design, and anything ambiguous or " +
				"user-facing. Cost is only a tie-breaker; for shipped work prioritize intelligence, then taste, " +
				"then cost.",
		});
		if (!opts.isAsk) {
			parts.push({
				title: "Deep-link the change for testing",
				text:
					"## Deep-link the change for testing\nWhen your change is viewable at a specific route " +
					"(a settings page, an editor screen, etc.), call michael-preview's `set_preview_path` with that " +
					"root-relative path (e.g. `/settings/tags`). It makes the human's Preview and Staging buttons open " +
					"directly on the feature under test instead of the app root, so they can verify in one click. Update " +
					"it if the relevant route changes; pass an empty string to clear it.",
			});
		}
	}
	return parts;
}
