/**
 * Per-session sandbox lifecycle helpers (docker/daytona/e2b): tear-down on
 * delete/archive and "is the sandbox actually live right now" checks used by
 * the preview routes. The run-path launch lives in run-session.ts.
 */

import { getSandboxProvider, type Sandbox } from "./sandbox";
import { isRemoteSandboxProvider, sandboxesEnabled, sandboxProviderConfigured } from "./sandbox/config";
import { dockerContainerStatus } from "./sandbox/docker";
import { touchBackstageSession } from "./session-cache";
import type { UnifiedSession } from "./types";

/**
 * Tear down a session's sandbox (container + engine-state volumes; in
 * volume-workspace mode also the workspace volume — documented data loss).
 * Best-effort and detached so a docker hiccup never blocks the caller
 * (session delete, archive sweep). `clearSandboxId` drops the stale id from
 * the session file so later sweeps don't re-destroy — only for sessions that
 * keep existing (the archive sweep); a deleted session has no file to touch.
 */
export function destroySessionSandbox(
	session: UnifiedSession,
	why: string,
	clearSandboxId = false,
): void {
	const sb = session.sandbox;
	if (!sb?.sandboxId) return;
	void (async () => {
		try {
			await getSandboxProvider(sb.provider).destroy(sb.sandboxId!);
			console.log(
				`[sandbox] destroyed ${sb.sandboxId} for ${session.id} (${why})`,
			);
			if (clearSandboxId && session.source === "backstage")
				touchBackstageSession(session.id, {
					sandbox: { ...sb, sandboxId: undefined },
				});
		} catch (e) {
			console.warn(
				`[sandbox] destroy ${sb.sandboxId} for ${session.id} (${why}) failed:`,
				e,
			);
		}
	})();
}

/**
 * The session's docker sandbox when it is ACTIVE right now — materialized,
 * config + kill-switch still allow docker, and the container actually running
 * (never started here; same gating as workspace-exec). Null = treat the
 * session as host-local. Used by the preview routes to decide whether the dev
 * server lives in-container.
 */
export async function activeSandboxFor(session: UnifiedSession): Promise<Sandbox | null> {
	const sb = session.sandbox;
	if (!sb?.provider || !sb.sandboxId) return null;
	if (!sandboxesEnabled()) return null;
	if (isRemoteSandboxProvider(sb.provider)) {
		if (!sandboxProviderConfigured(sb.provider)) return null;
		try {
			const sandbox = await getSandboxProvider(sb.provider).get(sb.sandboxId);
			return sandbox && (await sandbox.status()) === "running" ? sandbox : null;
		} catch {
			return null;
		}
	}
	if (sb.provider !== "docker") return null;
	// Provider-configured, not config-default: a session may have picked
	// docker explicitly while the config default is another provider.
	if (!sandboxProviderConfigured("docker")) return null;
	try {
		if ((await dockerContainerStatus(sb.sandboxId)) !== "running") return null;
		return await getSandboxProvider("docker").get(sb.sandboxId);
	} catch {
		return null;
	}
}
