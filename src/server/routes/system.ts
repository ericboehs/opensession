/**
 * Health check, in-process frontend rebuild, HTTP upload staging, audit-log viewer.
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
import { IS_DEV, buildFrontend, frontend } from "../frontend-build";
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
