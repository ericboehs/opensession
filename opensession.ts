#!/usr/bin/env bun

import { createGoalSelfMcpServer } from "./src/agents/slack/goal-tools";
import { type AgentModule } from "./src/agents/types";
import { ensureSeedActions } from "./src/server/actions";
import { activeAgentRunCount, resumeInterruptedRuns } from "./src/server/agent-runner";
import { archiveOlderThan } from "./src/server/archive";
import { makeAskHandler, pendingAsks } from "./src/server/asks";
import { startAutoArchiveSweep } from "./src/server/auto-archive";
import { getWebhookRoutes, setEventSessionCallback, startScheduler } from "./src/server/automations";
import { startUsagePoller } from "./src/server/claude-accounts";
import { FRONTEND_SRC, IS_DEV, frontend, scheduleFrontendRebuild, spaEntry } from "./src/server/frontend-build";
import { initHumanAsks } from "./src/server/human-asks";
import { interactiveMcpServers } from "./src/server/interactive-mcp";
import { OPENSESSION_CHATS_DIR } from "./src/server/paths";
import { startPlainArchiveSweep } from "./src/server/plain-archive";
import { startPublicIngress } from "./src/server/public-ingress";
import { envAlias } from "./src/server/rename-compat";
import { recordRecoveredRunEvent, restorePromptQueues, resumeDrainedSessions, snapshotActiveSessions } from "./src/server/run-session";
import { handleSandboxWsUpgrade } from "./src/server/run-ws";
import { type Sandbox } from "./src/server/sandbox";
import { findSession, invalidateSessionsCache, runErrors } from "./src/server/session-cache";
import { getSessionControl } from "./src/server/session-control";
import { buildReposNote } from "./src/server/session-repos";
import { destroySessionSandbox } from "./src/server/session-sandbox";
import { getAllSessions } from "./src/server/sessions";
import { startWebhookServer } from "./src/server/webhook-server";
import { sweepArchivedWorktrees } from "./src/server/worktree";
import { type WSClientData, broadcastToAll } from "./src/server/ws-hub";
import { mkdirSync, watch } from "fs";

// Side-effect modules: these must be loaded even when the entry references
// nothing from them — they register builders/listeners and start tickers.
import "./src/server/interactive-mcp"; // registerInteractiveMcpBuilder + run-rpc server
import "./src/server/queue-state"; // steer-receipt transcript reconcile listener
import "./src/server/run-session"; // /loop ticker
import "./src/server/goal-runner"; // goals ticker
import "./src/server/session-control-wiring"; // opensession-sessions MCP + Slack-link bridge
import { websocketHandlers } from "./src/server/ws-handlers";
import {
	routeHandlers,
	type RouteContext,
} from "./src/server/routes";

const PORT = parseInt(process.env.PORT || "3850");
const HOST = process.env.HOST || "127.0.0.1";
const HOME = process.env.HOME || "/home/ubuntu";
const SESSIONS_DIR = OPENSESSION_CHATS_DIR;

mkdirSync(SESSIONS_DIR, { recursive: true });

// --- Hot-reload support (bun --hot) ---------------------------------------
// Under `bun --hot`, editing a module re-evaluates this entry file in the SAME
// process, preserving `globalThis`. We exploit that so simple tweaks apply
// without dropping WebSocket clients or killing in-flight runs: live state
// (watchers, pending questions, queues) is parked on globalThis so the fresh
// module binding reuses the same instances, the HTTP/WS server is reloaded in
// place rather than rebound, and all one-time setup (agents, schedulers, timers,
// signal handlers) is guarded behind `__backstageBooted` so it never stacks.
// Long-lived agent *loop code* still needs a real restart — but that's now
// graceful (see SIGTERM handler below). A plain `bun run` (no --hot) just runs
// each branch once, exactly as before.
const g = globalThis as any;

// Loaded agents (Plain/Linear/Slack/Stripe/…). Module-scoped because request
// handlers (health routes) read it, and globalThis-backed so the set survives a
// hot reload (loadAgents runs only on a real boot, inside the guard below).
let agents: AgentModule[] = (g.__agents as AgentModule[] | undefined) ?? [];

console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

// Reuse the listening server across hot reloads so existing WebSocket clients
// and in-flight runs survive a tweak; a fresh `bun run` just creates it once.
// On every hot re-evaluation the freshly evaluated handlers (routes/fetch/
// websocket) are swapped into the LIVE server via server.reload() — a bare
// `??=` binding would keep the first evaluation's closures serving forever,
// which is exactly how route edits silently stopped hot-applying.
function hotServe(
	options: Parameters<typeof Bun.serve<WSClientData>>[0],
): import("bun").Server<WSClientData> {
	const live = g.__backstageServer as
		| import("bun").Server<WSClientData>
		| undefined;
	if (!live) return (g.__backstageServer = Bun.serve<WSClientData>(options));
	try {
		// reload's declared type is narrower than the full serve options, but it
		// accepts (and swaps) routes/fetch/websocket at runtime.
		live.reload(options as any);
	} catch (e) {
		console.error(
			"[hot-reload] server.reload failed — old handlers keep serving:",
			e,
		);
	}
	return live;
}
const server: import("bun").Server<WSClientData> = hotServe({
		port: PORT,
		hostname: HOST,
		// The plain-triage route waits for worktree+session boot (~15-60s);
		// Bun's default 10s idleTimeout would drop the connection mid-wait
		idleTimeout: 240,

		// The SPA shell is served at the bare domain root only (os.tella.dev,
		// 2026-07-10) — no path prefix. Old /opensession + /backstage page URLs
		// 301 onto the root form in the fetch preamble below.
		routes: Object.fromEntries(
			[
				"/",
				"/index.html",
				// Client-side routes must serve the SPA shell, not the raw file
				"/new",
				"/session/*",
				"/automations",
				"/security",
				"/goals",
				"/wiki",
				"/wiki/*",
				"/notes",
				"/notes/*",
				"/docs",
				"/docs/*",
				"/connections",
				"/settings",
				"/actions",
				"/archived",
				"/catchup",
				"/reviews",
				"/reviews/*",
				"/support/*",
			].map((p) => [p, spaEntry]),
		),

		async fetch(req) {
			const url = new URL(req.url);
			// The bare domain root is the ONLY public URL form (os.tella.dev,
			// 2026-07-10 — prefixes dropped). Handlers below still match the
			// historical /backstage/* literals, so the root form normalizes onto
			// /backstage here, and `${publicPrefix}/...` embeds (sw.js scope,
			// manifest start_url/icons, page redirects) stay root-relative
			// because publicPrefix is "" for it.
			//
			// Old-prefix traffic: page loads 301 to the root form; everything
			// else keeps normalizing silently instead of redirecting — WebSocket
			// upgrades (sandbox dial-back URLs baked into RUNNING sandboxes hit
			// run-ws/rpc-ws through the public ingress with the old literals) and
			// API calls from not-yet-reloaded tabs (a redirect would break POSTs).
			let path = url.pathname;
			const publicPrefix =
				path === "/opensession" || path.startsWith("/opensession/")
					? "/opensession"
					: path === "/backstage" || path.startsWith("/backstage/")
						? "/backstage"
						: "";
			if (publicPrefix === "/opensession") {
				path = "/backstage" + path.slice("/opensession".length);
			} else if (publicPrefix === "") {
				path = "/backstage" + path;
			}
			if (
				publicPrefix !== "" &&
				(req.method === "GET" || req.method === "HEAD") &&
				!req.headers.get("upgrade") &&
				!path.startsWith("/backstage/api/")
			) {
				const stripped = path.slice("/backstage".length) || "/";
				return Response.redirect(stripped + url.search, 301);
			}

			// Every API/asset route lives in src/server/routes/* — ordered domain
			// handlers that return undefined to fall through. Only the WebSocket
			// upgrades, the SPA fallback and the 404 stay here (they need `server`
			// or must run last).
			const ctx: RouteContext = { req, url, path, publicPrefix };
			for (const handler of routeHandlers) {
				const res = await handler(ctx);
				if (res) return res;
			}

			// WebSocket upgrade
			if (path === "/backstage/ws") {
				const upgraded = server.upgrade(req, {
					data: { watchingSessionId: null, watchingNoteId: null, user: null },
				});
				if (!upgraded) {
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return undefined;
			}

			// Sandbox WS transport (Phase 3): run hosts + MCP proxies inside
			// sandboxes dial back here instead of sharing unix sockets. BOTH
			// routes are gated BEFORE the upgrade on the run's per-launch
			// wsToken (hostId-keyed, registered only by ws-transport launches —
			// docker-ws / remote adapters), constant-time compared; rpc-ws
			// additionally needs ?host=<hostId>. Plain run-rpc tokens are NOT
			// network credentials: on a sandbox-less deployment the registry is
			// empty and every upgrade here is a 403. See src/server/run-ws.ts.
			if (path.startsWith("/backstage/run-ws/") || path === "/backstage/rpc-ws") {
				return handleSandboxWsUpgrade(req, server, path);
			}

			// SPA fallback: any unmatched GET under /backstage/ that isn't an API
			// path serves the app shell, so client-side routes deep-link correctly
			// even when they're missing from the explicit `routes` map above (which
			// has silently 404'd every newly added view — settings, actions — until
			// someone remembered to register it).
			if (
				frontend &&
				(req.method === "GET" || req.method === "HEAD") &&
				path.startsWith("/backstage/") &&
				!path.startsWith("/backstage/api/")
			) {
				return new Response(frontend.indexHtml, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			// 404
			return Response.json({ error: "Not found" }, { status: 404 });
		},

		// UI WebSocket handlers live in src/server/ws-handlers.ts (sandbox
		// transport sockets are delegated to run-ws.ts inside them).
		websocket: websocketHandlers,

		// Dev mode (HMR + error overlay + browser-console streaming) only when
		// explicitly asked for — the systemd service is production, and the overlay
		// pops "Script error." boxes on iOS with no diagnostics behind them.
		development:
			envAlias("OPENSESSION_DEV", "BACKSTAGE_DEV") === "1"
				? {
						hmr: true,
						console: true,
					}
				: false,
});

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);


// --- Agent loading and webhook server ---

async function loadAgents(): Promise<AgentModule[]> {
	const agents: AgentModule[] = [];

	if (process.env.ENABLE_PLAIN_AGENT !== "false") {
		try {
			const { PlainAgent } = await import("./src/agents/plain/index");
			agents.push(new PlainAgent());
			console.log("[agents] Plain agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load plain agent:", e);
		}
	}

	if (process.env.ENABLE_LINEAR_AGENT !== "false") {
		try {
			const { LinearAgent } = await import("./src/agents/linear/index");
			agents.push(new LinearAgent());
			console.log("[agents] Linear agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load linear agent:", e);
		}
	}

	if (process.env.ENABLE_SLACK_AGENT !== "false") {
		try {
			const { SlackAgent } = await import("./src/agents/slack/index");
			agents.push(new SlackAgent());
			console.log("[agents] Slack agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load slack agent:", e);
		}
	}

	// Gated on the signing secret: without it every webhook fails verification, so
	// there's no point exposing the route. Set STRIPE_WEBHOOK_SECRET to activate.
	if (
		process.env.ENABLE_STRIPE_AGENT !== "false" &&
		process.env.STRIPE_WEBHOOK_SECRET
	) {
		try {
			const { StripeAgent } = await import("./src/agents/stripe/index");
			agents.push(new StripeAgent());
			console.log("[agents] Stripe agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load stripe agent:", e);
		}
	}

	// Generic Grafana poller: drives every automation that carries a `grafanaPoll`
	// config (export failures, upload-processing failures, and any future signal
	// added as data). Gated on Grafana creds (the agent no-ops without them).
	if (process.env.ENABLE_GRAFANA_POLLER !== "false") {
		try {
			const { GrafanaPollerAgent } = await import(
				"./src/agents/grafana-poller/index"
			);
			agents.push(
				new GrafanaPollerAgent({
					onSessionInvalidate: () => {
						invalidateSessionsCache();
					},
				}),
			);
			console.log("[agents] Grafana poller loaded");
		} catch (e) {
			console.error("[agents] Failed to load grafana poller:", e);
		}
	}

	// GitHub PR agent: review / auto-fix / simplify on tella-fusion PRs. Receives
	// PR events forwarded from the Slack agent's /github/webhook; owns lifecycle
	// (seeds the disabled review automation, recovers interrupted fix loops).
	if (process.env.ENABLE_GITHUB_AGENT !== "false") {
		try {
			const { GithubAgent } = await import("./src/agents/github/index");
			agents.push(
				new GithubAgent({
					onSessionInvalidate: () => {
						invalidateSessionsCache();
					},
				}),
			);
			console.log("[agents] GitHub agent loaded");
		} catch (e) {
			console.error("[agents] Failed to load github agent:", e);
		}
	}

	return agents;
}

// One-time startup: agents, schedulers, recurring timers, and signal handlers.
// Guarded behind __backstageBooted so a `bun --hot` reload never double-starts
// any of it — the already-running agents/timers keep going untouched (only a
// real restart reloads their code, and that restart is now graceful, below).
if (!g.__backstageBooted) {
	// Public dial-back ingress for remote sandboxes (src/server/public-ingress.ts):
	// a second, isolated listener serving ONLY the run-ws/rpc-ws upgrades +
	// /ingress-health. No-op unless ~/.opensession-sandbox.json enables
	// publicIngress; starting/stopping it or changing its port needs a real
	// restart (the config's other values stay read-fresh-per-run).
	try {
		startPublicIngress();
	} catch (e) {
		console.error("[public-ingress] failed to start:", e);
	}

	// Start webhook server with enabled agents + automation webhook triggers
	agents = await loadAgents();
	g.__agents = agents;
	const webhookServer = startWebhookServer(
		agents,
		getWebhookRoutes(() => {
			invalidateSessionsCache();
		}),
	);
	void webhookServer;

	// Seed the make_*_editor.sh action family (create-if-absent, UI edits preserved).
	try {
		ensureSeedActions();
	} catch (e) {
		console.error("[actions] Failed to seed actions:", e);
	}

	// Seed cron-scheduled "sweep" loops (Production Error Sweep, …) as automations
	// before the scheduler starts. Create-if-absent, so UI edits are preserved.
	try {
		const { ensureSweepLoops } = await import("./src/agents/loops/sweep");
		ensureSweepLoops();
		const { ensureMonitors } = await import("./src/agents/loops/monitor");
		ensureMonitors();
		const { ensureSeoLoops } = await import("./src/agents/loops/seo");
		ensureSeoLoops();
		const { ensureStalePrMonitor } = await import(
			"./src/agents/loops/stale-prs"
		);
		ensureStalePrMonitor();
		const { ensureCronJobs } = await import("./src/agents/loops/cron-jobs");
		ensureCronJobs();
		// Autonomous session monitor (per-user, opt-in — Settings → Monitor)
		const { startSessionMonitor } = await import(
			"./src/agents/loops/session-monitor"
		);
		startSessionMonitor();
	} catch (e) {
		console.error(
			"[loops] Failed to seed sweep/monitor/seo/stale-pr/cron loops:",
			e,
		);
	}

	// Cron-scheduled automations + internal event bus (agents → automations)
	startScheduler(() => {
		invalidateSessionsCache();
	});
	setEventSessionCallback(() => {
		invalidateSessionsCache();
	});

	// Scheduled prompts ("send this to this session at 5pm") — deliver due ones
	// through the SessionControl registry, exactly like a typed message.
	setInterval(() => {
		void (async () => {
			const { takeDuePrompts } = await import(
				"./src/server/scheduled-prompts"
			);
			for (const p of takeDuePrompts()) {
				try {
					const result = await getSessionControl().deliverToSession(
						p.sessionId,
						p.prompt,
						p.user,
					);
					console.log(
						`[scheduled-prompts] ${p.id} → ${p.sessionId}: ${result.status}`,
					);
				} catch (e) {
					console.error(`[scheduled-prompts] ${p.id} delivery failed:`, e);
				}
			}
		})();
	}, 30_000);

	// Archive triage sessions when their Plain ticket is done
	startPlainArchiveSweep(() => {
		invalidateSessionsCache();
	});

	// Auto-archive sessions that look done (merged PR, or opt-in green checks) —
	// per-user, opt-in by repo (Settings → Auto-archive), on by default only for
	// the backstage repo itself.
	startAutoArchiveSweep(
		() =>
			getAllSessions().map((s) => ({
				...s,
				waitingForInput: pendingAsks.has(s.id),
				lastRunError: runErrors.get(s.id) || s.lastRunError,
			})),
		() => {
			invalidateSessionsCache();
		},
	);

	// Poll per-account Claude usage (drives account picking + the Connections UI)
	startUsagePoller();

	// Resume Claude runs a previous process left in-flight (restart/crash), then
	// wake any session that finished its turn during the shutdown drain (so the
	// journal no longer held it). Together these wake every session that was
	// active before the restart.
	setTimeout(() => {
		const resumedIds = resumeInterruptedRuns(
			() => {
				invalidateSessionsCache();
			},
			// Re-attach the AskUserQuestion handler so a run that was blocked on an
			// ask (web UI or Slack escalation) can ask again after the restart instead
			// of dead-ending headless. Automations stay headless by design.
			(bksSessionId) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return makeAskHandler(bksSessionId);
			},
			(bksSessionId, user) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return session.goalId
					? {
							...interactiveMcpServers(user, bksSessionId),
							"opensession-goal-self": createGoalSelfMcpServer(session.goalId),
						}
					: interactiveMcpServers(user, bksSessionId);
			},
			(bksSessionId) => {
				const session = findSession(bksSessionId);
				if (!session || session.source !== "backstage" || session.automation)
					return undefined;
				return buildReposNote(session);
			},
			recordRecoveredRunEvent,
		);
		if (resumedIds.length > 0) {
			console.log(
				`[runner] Resumed ${resumedIds.length} interrupted run(s) from before restart`,
			);
			invalidateSessionsCache();
		}
		resumeDrainedSessions(new Set(resumedIds));
		// Re-deliver messages that were queued/steered when the process went down.
		restorePromptQueues();
		// Restore human-in-the-loop asks: re-arm scheduled timers, and degrade any
		// block asks that lost their held turn to async so late replies still land.
		initHumanAsks();
	}, 3000);

	// Ongoing hygiene (every 6h): archive sessions idle for more than a week,
	// then remove worktrees of archived sessions idle >14 days with no WIP.
	setInterval(
		async () => {
			const count = archiveOlderThan(getAllSessions(), 7);
			if (count > 0) {
				console.log(`[archive] Auto-archived ${count} session(s) idle >7 days`);
				invalidateSessionsCache();
			}
			try {
				const removed = await sweepArchivedWorktrees(getAllSessions(), 14);
				if (removed.length > 0) {
					console.log(
						`[worktree-sweep] Removed ${removed.length} clean worktree(s): ${removed.join(", ")}`,
					);
					invalidateSessionsCache();
				}
			} catch (e) {
				console.error("[worktree-sweep] Sweep failed:", e);
			}
			// Sandboxes of long-idle archived sessions, same cadence as the
			// worktree sweep: containers + engine-state volumes are provider-owned
			// and safe to drop (bind-mode worktrees belong to the sweep above and
			// are untouched). Volume-mode workspaces die with the sandbox — the
			// documented contract of that mode (push your work). A revived session
			// just re-ensures a fresh container on its next prompt.
			try {
				const cutoff = Date.now() - 14 * 86_400_000;
				for (const s of getAllSessions()) {
					if (!s.sandbox?.sandboxId || !s.archived || s.isRunning) continue;
					if (new Date(s.lastActivity).getTime() >= cutoff) continue;
					destroySessionSandbox(s, "archive-sweep", true);
				}
			} catch (e) {
				console.error("[sandbox-sweep] Sweep failed:", e);
			}
		},
		6 * 60 * 60 * 1000,
	);

	// Run agent startup hooks
	for (const agent of agents) {
		try {
			await agent.startup();
			console.log(`[agents] ${agent.name} agent started`);
		} catch (e) {
			console.error(`[agents] ${agent.name} agent startup failed:`, e);
		}
	}

	// Graceful shutdown: stop taking new work, let in-flight runs reach a natural
	// stopping point (bounded), then exit — instead of killing every run mid-turn.
	// Anything still running after the drain window is picked up by the run
	// journal on the next boot (resumeInterruptedRuns), so nothing is lost.
	// 2-min default so in-flight runner runs have a real chance to finish their
	// current turn before exit. Must stay below the unit's TimeoutStopSec (140s),
	// or systemd SIGKILLs the process mid-drain.
	const DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || "120000");
	let shuttingDown = false;
	const gracefulShutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(
			`[shutdown] ${signal} — stopping intake and draining in-flight runs…`,
		);
		// Snapshot active sessions BEFORE the drain — the drain lets runs finish
		// their turn and clear themselves from the journal, so this is the only
		// record of sessions that should be woken on the next boot.
		snapshotActiveSessions();
		// Tell connected UIs we're going down so they can show a "restarting" modal
		// and auto-refresh once the new instance is up (instead of silently queuing
		// messages that would be lost). Brief pause to let the frames flush.
		broadcastToAll({ type: "server_restarting" });
		await new Promise((r) => setTimeout(r, 150));
		// Stop agents from accepting new work (Slack socket, webhook intake, …).
		// BOUNDED: an agent shutdown that awaits a flaky network call (e.g. the
		// Slack socket close during a Slack outage) used to hang here for the
		// whole TimeoutStopSec — the drain loop below never even started and
		// systemd SIGKILLed everything at 140s (observed 2026-07-09 10:15).
		for (const agent of agents) {
			const t0 = Date.now();
			try {
				const r = await Promise.race([
					Promise.resolve(agent.shutdown()).then(() => "ok" as const),
					new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
				]);
				if (r === "timeout") {
					console.warn(
						`[shutdown] ${agent.name} shutdown still pending after 10s — moving on`,
					);
				} else {
					console.log(`[shutdown] ${agent.name} stopped (${Date.now() - t0}ms)`);
				}
			} catch (e) {
				console.error(`[shutdown] ${agent.name} shutdown error:`, e);
			}
		}
		// Stop accepting new HTTP/WS connections; existing ones can finish.
		try {
			server.stop();
		} catch {}
		// Wait for runner-driven runs (web UI / automations / loops) to settle.
		const deadline = Date.now() + DRAIN_TIMEOUT_MS;
		let n = activeAgentRunCount();
		while (n > 0 && Date.now() < deadline) {
			console.log(`[shutdown] waiting on ${n} in-flight run(s)…`);
			await new Promise((r) => setTimeout(r, 500));
			n = activeAgentRunCount();
		}
		if (n > 0) {
			console.log(
				`[shutdown] ${n} run(s) still active after ${DRAIN_TIMEOUT_MS}ms — the journal will resume them on restart`,
			);
		} else {
			console.log("[shutdown] all in-flight runs drained cleanly");
		}
		process.exit(0);
	};
	process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
	process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

	// Frontend live-reload: rebuild the SPA bundle in-process when its source
	// changes, so a CSS/frontend tweak no longer needs a `systemctl restart` that
	// interrupts every running session. `kill -USR2 <pid>` forces it too (drop-in
	// for restart in a deploy script). Guarded by __backstageBooted so a hot
	// reload doesn't stack watchers/handlers. recursive watch needs Linux ≥ 6.x
	// (we're on 6.17) — fine here.
	if (!IS_DEV && frontend) {
		try {
			const watcher = watch(FRONTEND_SRC, { recursive: true }, (_evt, file) => {
				if (file && /\.(tsx?|css|html)$/.test(file.toString())) {
					scheduleFrontendRebuild(`watch:${file}`);
				}
			});
			process.on("exit", () => watcher.close());
			console.log(`[frontend] Watching ${FRONTEND_SRC} for live rebuilds`);
		} catch (e) {
			console.error(
				"[frontend] Could not start file-watch (use SIGUSR2/endpoint to rebuild):",
				e,
			);
		}
		process.on("SIGUSR2", () => scheduleFrontendRebuild("SIGUSR2", 0));
	}

	g.__backstageBooted = true;
}
