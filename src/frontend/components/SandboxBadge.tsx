import React from "react";
import { Tooltip } from "../ui/tooltip";
import { IconBox } from "./icons";

/**
 * Small "this session runs in a sandbox" badge (the sandbox rollout plan Phase 4):
 * provider name + workspace mode, rendered purely from the session's `sandbox`
 * field — no live container polling from the frontend (state that isn't on the
 * session object is deliberately not shown). Renders nothing for plain host
 * sessions and for `provider: "local"` (a recorded opt-in that resolved to
 * today's host behavior — a badge there would only confuse).
 */
export function SandboxBadge({
	sandbox,
}: {
	sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
}) {
	if (!sandbox?.provider || sandbox.provider === "local") return null;
	const mode = sandbox.workspace === "volume" ? "volume" : "bind";
	const materialized = Boolean(sandbox.sandboxId);
	const label = [
		`Runs in an isolated ${sandbox.provider} sandbox. The agent and its commands run inside a per-session container, not on the host.`,
		mode === "volume"
			? "Volume workspace: the checkout lives only inside the sandbox; deleting the session deletes un-pushed work."
			: "Bind workspace: the host worktree is mounted into the sandbox, so diffs, pushes and previews work as usual.",
		materialized ? undefined : "Not started yet. It's created on the first run.",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<Tooltip label={label} multiline>
			<span
				className="flex flex-none cursor-default items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-meta font-medium text-dim"
				data-testid="sandbox-badge"
			>
				<IconBox size={20} className="text-faint" />
				<span>{sandbox.provider}</span>
				<span className="text-faint">· {mode}</span>
			</span>
		</Tooltip>
	);
}
