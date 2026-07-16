/**
 * Health check, macropad keypad feed, in-process frontend rebuild, HTTP upload staging, audit-log viewer.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { readFileSync, statfsSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import type { RouteContext } from "./context";
import { activeAgentRunCount } from "../agent-runner";
import { getAgents } from "../agents-registry";
import { configuredServer } from "../config";
import { IS_DEV, buildFrontend, frontend } from "../frontend-build";
import { getPins } from "../pins";
import { getReads, isUnread } from "../reads";
import { runErrors } from "../session-cache";
import { getSessionControl } from "../session-control";
import { MAX_UPLOAD_BYTES, stageHttpUpload } from "../uploads";
import { BOOT_ID, broadcastToAll } from "../ws-hub";

/** Host metrics for the health endpoint. The health-monitor automation runs
 *  in ask mode on the opencode engine, where the bash tool is unavailable to
 *  unattended runs — webfetching this endpoint is its only way to see disk/
 *  memory/CPU, so keep these fields stable. */
function systemStats(): Record<string, unknown> {
	try {
		const mem: Record<string, number> = {};
		for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
			const m = line.match(/^(\w+):\s+(\d+) kB/);
			if (m) mem[m[1]] = Number(m[2]) * 1024;
		}
		const s = statfsSync("/");
		const totalBytes = s.blocks * s.bsize;
		const availBytes = s.bavail * s.bsize;
		const [load1, load5, load15] = loadavg();
		return {
			disk: {
				mount: "/",
				totalGb: +(totalBytes / 1e9).toFixed(1),
				availGb: +(availBytes / 1e9).toFixed(1),
				usedPct: +((1 - availBytes / totalBytes) * 100).toFixed(1),
			},
			memory: {
				totalGb: +((mem.MemTotal || 0) / 1e9).toFixed(2),
				availableGb: +((mem.MemAvailable || 0) / 1e9).toFixed(2),
				availablePct: mem.MemTotal
					? +(((mem.MemAvailable || 0) / mem.MemTotal) * 100).toFixed(1)
					: null,
				swapUsedGb: +(((mem.SwapTotal || 0) - (mem.SwapFree || 0)) / 1e9).toFixed(2),
			},
			load: { "1m": load1, "5m": load5, "15m": load15, cores: cpus().length },
		};
	} catch (e) {
		return { error: String((e as Error)?.message || e) };
	}
}

export async function handleSystemRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Health check (includes agent health — Tailscale-only, not public).
	// frontendVersion lets clients detect a frontend-only rebuild (no bootId
	// change) and refresh.
	if (path === "/backstage/api/health") {
		const agentHealth: Record<string, unknown> = {};
		for (const a of getAgents()) {
			agentHealth[a.name] = a.health();
		}
		return Response.json({
			ok: true,
			bootId: BOOT_ID,
			frontendVersion: frontend?.version ?? null,
			uptime: process.uptime(),
			// In-flight runner runs this process is driving — a drain-aware deploy
			// polls this to restart only when the service is idle (or near it), so a
			// restart kills as few in-flight runs/background tasks as possible.
			activeRuns: activeAgentRunCount(),
			agents: agentHealth,
			system: systemStats(),
		});
	}

	// ── Macropad status feed ──
	// A user's pinned sessions (pinned order, max 8) with a coarse status per
	// key, for a hardware keypad. Polled ~every 1.5s, so it only touches
	// in-memory state: the per-user pins file plus the 2s session cache behind
	// SessionControl. Same auth posture as /api/health (none — network-gated).
	if (path === "/backstage/api/keypad" && req.method === "GET") {
		const user = url.searchParams.get("user") || "Anonymous";
		const control = getSessionControl();
		// Per-user read marks (mirrored from the app's localStorage — reads.ts),
		// so a finished session with activity newer than the last-read mark shows
		// as unread on the macropad.
		const reads = getReads(user);
		// Canonical open-in-app link per session (the macropad opens it on
		// keypress) — same shape as the frontend's chatPath (share-link.ts):
		// workspace-scoped when the chat belongs to a Project.
		const uiBase = configuredServer().publicBaseUrl;
		const sessions: Array<{
			id: string;
			title: string;
			status: "idle" | "working" | "needs_input" | "unread" | "error";
			url: string;
		}> = [];
		for (const key of getPins(user)) {
			if (sessions.length >= 8) break;
			// Pins also hold workspace rows (`workspace:<id>`) — not sessions.
			if (key.startsWith("workspace:")) continue;
			const s = control.getSession(key);
			if (!s || s.state === "archived") continue;
			// A queued prompt means the session is about to run — show it as
			// working, same as taskStateOf (sessions-tools.ts). An engine session
			// id means it has run before, so an idle session with one is "done";
			// without one it's a fresh pinned chat that never ran.
			const lastRunError = runErrors.get(s.id) || s.lastRunError;
			// Precedence (first match wins) — surface the single most important
			// thing: error > working > needs_input > unread > idle. The old "done"
			// (finished, has run before) collapses into idle; "unread" is the
			// finished-with-new-activity case (lastActivity newer than the user's
			// read mark). See src/server/reads.ts.
			const status: "idle" | "working" | "needs_input" | "unread" | "error" =
				lastRunError
					? "error"
					: s.state === "running" || s.state === "queued"
						? "working"
						: s.state === "waiting_question"
							? "needs_input"
							: isUnread(s.lastActivity, reads[s.id])
								? "unread"
								: "idle";
			const sessionUrl = s.projectId
				? `${uiBase}/workspace/${encodeURIComponent(s.projectId)}/chat/${encodeURIComponent(s.id)}`
				: `${uiBase}/session/${encodeURIComponent(s.id)}`;
			sessions.push({
				id: s.id,
				title: s.title || "Untitled",
				status,
				url: sessionUrl,
			});
		}
		return Response.json({ sessions });
	}

	// Rebuild the frontend bundle in-process (no restart → live runs untouched).
	// Drop-in replacement for `systemctl restart backstage` after a frontend/CSS
	// change. Tailscale + team gated at the network layer like every route here.
	if (path === "/backstage/api/rebuild-frontend" && req.method === "POST") {
		if (IS_DEV || !frontend) {
			return Response.json(
				{ ok: false, error: "not available in dev mode" },
				{ status: 400 },
			);
		}
		try {
			const version = await buildFrontend();
			broadcastToAll({ type: "frontend_updated", version });
			return Response.json({ ok: true, version });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String(e) },
				{ status: 500 },
			);
		}
	}

	// Stream a large composer attachment straight to disk (base64-over-WS
	// can't carry big files). Body is the raw file bytes; filename in the
	// `x-file-name` header. Returns { name, path } the client echoes back in
	// its next prompt/create_session `files` entry.
	if (path === "/backstage/api/upload" && req.method === "POST") {
		try {
			const rawName = req.headers.get("x-file-name") || "file";
			const name = decodeURIComponent(rawName);
			const len = Number(req.headers.get("content-length") || 0);
			if (len > MAX_UPLOAD_BYTES) {
				return Response.json(
					{
						ok: false,
						error: `File too large (${len} bytes, max ${MAX_UPLOAD_BYTES}).`,
					},
					{ status: 413 },
				);
			}
			const staged = await stageHttpUpload(name, req);
			return Response.json({ ok: true, ...staged });
		} catch (e) {
			return Response.json(
				{ ok: false, error: String((e as Error)?.message || e) },
				{ status: 400 },
			);
		}
	}

	// ── Audit digest: one day rolled up for the nightly Dreaming automation ──
	// The raw jsonl is 10-20MB (too big to shell-process), so this rolled-up
	// endpoint is that run's window into yesterday's work — like /api/health for
	// the health monitor. Default date is yesterday (UTC). Use `?section=` to
	// pull individual detail sections under the engine's tool-output cap.
	if (path === "/backstage/api/audit/digest" && req.method === "GET") {
		const { buildAuditDigest, listAuditDates } = await import(
			"../../server/audit"
		);
		const date =
			url.searchParams.get("date") ||
			new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		const digestJson = buildAuditDigest(date);
		if (!digestJson) {
			return Response.json(
				{
					ok: false,
					error: `no audit log for ${date}`,
					dates: listAuditDates().slice(0, 7),
				},
				{ status: 404 },
			);
		}
		// Join automation runs so automation sessions carry a readable name.
		const { listAutomations } = await import("../automations");
		const automationRuns: Array<Record<string, unknown>> = [];
		const nameBySession = new Map<string, string>();
		for (const a of listAutomations()) {
			for (const r of a.runs || []) {
				if (String(r.at).slice(0, 10) !== date) continue;
				automationRuns.push({
					automation: a.name,
					at: r.at,
					trigger: r.trigger,
					status: r.status,
					durationMs: r.durationMs,
					sessionId: r.sessionId,
				});
				if (r.sessionId) nameBySession.set(r.sessionId, a.name);
			}
		}
		for (const s of digestJson.sessions as Array<Record<string, unknown>>) {
			const name = nameBySession.get(String(s.id));
			if (name) s.automation = name;
		}
		const full: Record<string, unknown> = { ok: true, ...digestJson, automationRuns };
		// The full digest is 50-70KB, which trips the engine's large-tool-output
		// truncation (the body spills to a file and the inline view is cut). A
		// `?section=errorGroups,sessions` filter lets a caller pull one or two
		// detail sections at a time, each small enough to land inline. `ok`,
		// `date` and a `sections` index of what's available always ride along.
		const section = url.searchParams.get("section");
		if (section) {
			const want = new Set(section.split(",").map((s) => s.trim()).filter(Boolean));
			const picked: Record<string, unknown> = {
				ok: true,
				date,
				sections: Object.keys(full).filter((k) => k !== "ok"),
			};
			for (const k of want) if (k in full) picked[k] = full[k];
			return Response.json(picked);
		}
		return Response.json(full);
	}

	// ── Audit log viewer (Settings → Audit log) ──
	if (path === "/backstage/api/audit" && req.method === "GET") {
		const { listAuditDates, readAuditEvents } = await import(
			"../../server/audit"
		);
		const date = url.searchParams.get("date") || "";
		const dates = listAuditDates();
		if (!date) return Response.json({ dates });
		return Response.json({
			dates,
			...readAuditEvents({
				date,
				q: url.searchParams.get("q") || undefined,
				type: url.searchParams.get("type") || undefined,
				session: url.searchParams.get("session") || undefined,
				significantOnly: url.searchParams.get("all") !== "1",
				offset: Number(url.searchParams.get("offset")) || 0,
				limit: Number(url.searchParams.get("limit")) || 200,
			}),
		});
	}

	return undefined;
}
