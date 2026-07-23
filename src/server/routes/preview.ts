/**
 * Dev-server ("Preview") lifecycle for a session's worktree: status, screenshot, start, stop.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { getPreviewStatus, getSandboxPreviewStatus, startPreview, startSandboxPreview, stopPreview, stopSandboxPreview } from "../preview";
import { findSession } from "../session-cache";
import { activeSandboxFor } from "../session-sandbox";
import { existsSync } from "fs";

export async function handlePreviewRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// Local dev-server ("Preview") status for a session's worktree — which
	// services (.ports.conf) are listening, so the header can link to the
	// webapp and show/stop running processes.
	{
		const m = path.match(/^\/backstage\/api\/sessions\/(.+)\/preview$/);
		if (m && req.method === "GET") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			// Sandboxed session with a running container: the dev server (if
			// any) lives in-container — status/ports/Caddy go through the
			// sandbox. Otherwise the host path below, unchanged.
			// Who this preview belongs to — the interstitial displays it so a
			// stale/reused tab can never masquerade as another session's wait.
			const who = {
				sessionTitle: session.title || null,
				sessionBranch: session.branch || null,
			};
			const sbx = session.worktreeDir
				? await activeSandboxFor(session)
				: null;
			if (sbx)
				return Response.json({
					...(await getSandboxPreviewStatus(sbx, session.worktreeDir!)),
					...who,
				});
			if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
				return Response.json({
					hasPortsConf: false,
					webappPort: null,
					running: false,
					starting: false,
					previewUrl: null,
					services: [],
					...who,
				});
			}
			return Response.json({
				...(await getPreviewStatus(session.worktreeDir)),
				...who,
			});
		}
	}

	// Screenshot the running preview (headless Chrome → PNG).
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/preview\/screenshot$/,
		);
		if (m && req.method === "POST") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			const sbx = session.worktreeDir
				? await activeSandboxFor(session)
				: null;
			if (!session.worktreeDir || (!existsSync(session.worktreeDir) && !sbx))
				return Response.json(
					{ error: "Session has no worktree" },
					{ status: 400 },
				);
			try {
				const { capturePreviewScreenshot } = await import(
					"../../server/preview"
				);
				// Sandboxed previews: hand the capture the sandbox-derived status
				// (host status can't see in-container listeners); the URL itself
				// is an ordinary Caddy-fronted https origin either way.
				const png = await capturePreviewScreenshot(session.worktreeDir, {
					...(sbx
						? {
								status: await getSandboxPreviewStatus(
									sbx,
									session.worktreeDir,
								),
							}
						: {}),
				});
				return new Response(new Uint8Array(png), {
					headers: { "Content-Type": "image/png" },
				});
			} catch (e: any) {
				return Response.json(
					{ error: e?.message || "Screenshot failed" },
					{ status: 500 },
				);
			}
		}
	}

	// Start the session's dev server (Tella Local) if it isn't up yet.
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/preview\/start$/,
		);
		if (m && req.method === "POST") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			// In-container start is gated on config devServerInSandbox — see
			// startSandboxPreview; without the gate it just reports status.
			const sbx = session.worktreeDir
				? await activeSandboxFor(session)
				: null;
			if (sbx)
				return Response.json(
					await startSandboxPreview(sbx, session.worktreeDir!),
				);
			if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
				return Response.json({
					hasPortsConf: false,
					webappPort: null,
					running: false,
					starting: false,
					previewUrl: null,
					services: [],
				});
			}
			return Response.json(await startPreview(session.worktreeDir));
		}
	}

	// Stop the session's dev server (scoped to its worktree's process group).
	{
		const m = path.match(
			/^\/backstage\/api\/sessions\/(.+)\/preview\/stop$/,
		);
		if (m && req.method === "POST") {
			const session = findSession(decodeURIComponent(m[1]));
			if (!session)
				return Response.json(
					{ error: "Session not found" },
					{ status: 404 },
				);
			// Sandboxed dev servers are stopped in-container (host pgids can't
			// reach them); also drops the Caddy route.
			const sbx = session.worktreeDir
				? await activeSandboxFor(session)
				: null;
			if (sbx)
				return Response.json(
					await stopSandboxPreview(sbx, session.worktreeDir!),
				);
			if (!session.worktreeDir || !existsSync(session.worktreeDir)) {
				return Response.json({
					hasPortsConf: false,
					webappPort: null,
					running: false,
					starting: false,
					previewUrl: null,
					services: [],
				});
			}
			return Response.json(await stopPreview(session.worktreeDir));
		}
	}

	return undefined;
}
