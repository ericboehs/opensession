/**
 * In-process self-management MCP servers for INTERACTIVE Backstage sessions
 * (web UI + loops) — the same opensession-sessions / opensession-admin tools the Slack
 * agent gets, so you can list/steer sessions and manage automations/MCPs from a
 * Michael session. Built fresh per run from the prompt's author. NEVER pass
 * these to automation runs or to interactive resumes of automation-owned
 * sessions — untrusted ticket text must not reach session-control / config
 * tools. Backstage is Tailscale- and team-gated and already exposes all of this
 * through its UI, so interactive users are treated as admin.
 */

import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { createAdminMcpServer } from "../agents/slack/admin-tools";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createAskUserMcpServer } from "../agents/slack/ask-tools";
import { createReposMcpServer } from "../agents/slack/repos-tools";
import { createPreviewMcpServer } from "../agents/slack/preview-tools";
import { createMemoryMcpServer } from "../agents/slack/memory-tools";
import { createGoalsMcpServer, createGoalSelfMcpServer } from "../agents/slack/goal-tools";
import { productName } from "./config";
import { repoForPath, REPOS } from "./worktree";
import { registerInteractiveMcpBuilder, startRunRpcServer } from "./run-rpc";
import { findSession, touchBackstageSession } from "./session-cache";
import { attachRepo, linkPr, sessionRepoIds, switchPrimaryRepo } from "./session-repos";
import { makeAskHandler } from "./asks";

export function interactiveMcpServers(
	user?: string,
	sessionId?: string,
): Record<string, unknown> {
	const createdBy = user || productName();
	return {
		"opensession-sessions": createSessionsMcpServer({
			createdBy,
			isAdmin: true,
			currentSessionId: sessionId,
		}),
		"opensession-admin": createAdminMcpServer({
			channel: "backstage",
			userId: user || "backstage",
			isDM: false,
			isPrivate: false,
			createdBy,
			isAdmin: true,
		}),
		// Long-running goals: create/list/steer persistent, self-pacing missions.
		"opensession-goals": createGoalsMcpServer({ createdBy, isAdmin: true }),
		// Human-in-the-loop: ask a teammate and fold the answer back into this
		// session. Needs the session id so the answer routes home. Withheld (like
		// the others) from automation runs — see the runSessionPrompt call site.
		...(sessionId
			? {
					"opensession-humans": createHumansMcpServer({
						sessionId,
						createdBy,
						isAdmin: true,
					}),
					// Cross-repo: attach secondary repos as isolated worktrees.
					"opensession-repos": createReposMcpServer({
						sessionId,
						attach: (repo, branch) => attachRepo(sessionId, repo, branch),
						switchPrimary: (repo) => switchPrimaryRepo(sessionId, repo),
						snapshot: () => {
							const s = findSession(sessionId);
							if (!s) return null;
							return {
								primaryRepo:
									s.repo ||
									(s.worktreeDir
										? repoForPath(s.worktreeDir).id
										: "tella-fusion"),
								branch: s.branch,
								worktreeDir: s.worktreeDir,
								attached: s.attachedRepos || [],
							};
						},
						repos: () =>
							Object.values(REPOS).map((p) => ({
								id: p.id,
								defaultBranch: p.defaultBranch,
								sharedCheckout: !!p.sharedCheckout,
							})),
						linkPr: (input) => linkPr(sessionId, input),
					}),
					// Durable repo/user/team memory (stored under ~/.michael-memory,
					// shared both ways with Slack's channel memory). Write tools are
					// interactive-only — automation runs get read-only injection; see
					// memory-tools.ts for the trust model.
					"opensession-memory": createMemoryMcpServer({
						user,
						repos: () => {
							const s = findSession(sessionId);
							return s ? sessionRepoIds(s) : [];
						},
					}),
					// Deep-link testing: record where the change should be tested so
					// the Preview/Staging buttons open that route directly.
					"opensession-preview": createPreviewMcpServer({
						sessionId,
						setPreviewPath: (path) =>
							touchBackstageSession(sessionId, {
								previewPath: path || undefined,
							}),
						current: () => findSession(sessionId)?.previewPath ?? null,
					}),
					// AskUserQuestion for engines without a canUseTool hook (Codex):
					// blocks on the same UI question card + Slack escalation as the
					// native Claude tool. claude-runner strips this server so Claude
					// keeps using the native AskUserQuestion instead of a duplicate.
					"opensession-ask": createAskUserMcpServer({
						ask: makeAskHandler(sessionId),
					}),
				}
			: {}),
	};
}

// Codex cannot consume Claude SDK in-process MCP servers directly. Expose the
// same interactive opensession-* tools through the run-rpc stdio proxy so Codex
// sessions can inspect/create/steer Backstage sessions too. Goal-driven
// sessions additionally get opensession-goal-self (next-wake/ledger/pause tools),
// matching what the in-process path hands them at the runAgent call sites.
registerInteractiveMcpBuilder((sessionId, user) => {
	const servers = interactiveMcpServers(user, sessionId);
	const goalId = sessionId ? findSession(sessionId)?.goalId : undefined;
	if (goalId)
		(servers as Record<string, unknown>)["opensession-goal-self"] =
			createGoalSelfMcpServer(goalId);
	return servers;
});
startRunRpcServer();
