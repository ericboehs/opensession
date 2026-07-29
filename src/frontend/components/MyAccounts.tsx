import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { cn } from "../ui/cn";
import { IconTile, displayName } from "./BrandTile";
import { useCurrentUser } from "./UserPicker";
import { GithubAccounts, SectionHeading } from "./Connections";

interface OauthStatus {
	shared?: { connectedBy?: string };
	users: string[];
	/** Server publishes OAuth metadata (connectable even if it runs on a
	 *  workspace API key today, e.g. posthog). */
	capable?: boolean;
}

/**
 * Settings → Personal → My accounts: every per-user sign-in in one place —
 * OAuth-capable MCP servers (connect as yourself; your sessions then use
 * YOUR account, falling back to the workspace grant — src/server/mcp-oauth.ts)
 * plus the per-user GitHub auth section (PRs as yourself). Workspace-wide
 * MCP grants stay on the Connections page's server cards (admin surface).
 */
export function MyAccountsPanel() {
	const currentUser = useCurrentUser();
	const [servers, setServers] = useState<
		{ name: string; transport: string; status: string }[] | null
	>(null);
	const [oauthByName, setOauthByName] = useState<Record<string, OauthStatus>>(
		{},
	);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${BASE_PATH}/api/connections`);
			if (!res.ok) return;
			const body = await res.json();
			// All servers — stdio ones can be OAuth-capable too via presets
			// (Slack user tokens); the status endpoint's `capable` decides.
			const mcp = body.mcpServers || [];
			setServers(mcp);
			const entries = await Promise.all(
				mcp.map(async (s: { name: string }) => {
					try {
						const r = await fetch(
							`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth`,
						);
						return r.ok ? ([s.name, await r.json()] as const) : null;
					} catch {
						return null;
					}
				}),
			);
			setOauthByName(Object.fromEntries(entries.filter(Boolean) as any));
		} catch {}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function connect(name: string) {
		try {
			const res = await fetch(
				`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(name)}/oauth/start`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ scope: "me" }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			window.open(body.url, "_blank", "noopener");
			// Re-poll for a while so the row flips once they approve the consent.
			let polls = 0;
			const t = setInterval(() => {
				if (++polls > 24) return clearInterval(t);
				void load();
			}, 5000);
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function disconnect(name: string) {
		try {
			const res = await fetch(
				`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(name)}/oauth?scope=me`,
				{ method: "DELETE" },
			);
			if (!res.ok)
				throw new Error((await res.json()).error || `Failed: ${res.status}`);
			void load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	const isMe = (teamName: string) => {
		const a = teamName.toLowerCase();
		const b = (currentUser || "").toLowerCase();
		return !!b && (a === b || a.startsWith(b) || b.startsWith(a));
	};
	// OAuth-capable = the server publishes OAuth metadata (even when it runs
	// on a workspace key today), needs sign-in, or already has grants.
	const oauthServers = (servers || []).filter(
		(s) =>
			s.status === "needs-auth" ||
			oauthByName[s.name]?.capable ||
			oauthByName[s.name]?.shared ||
			oauthByName[s.name]?.users.length,
	);

	return (
		<div className="settings-panel">
			<div className="page-header">
				<div>
					<h2 className="page-title">My accounts</h2>
					<div className="page-sub">
						Your personal sign-ins. Sessions act as you where you're
						connected; otherwise they fall back to the workspace account.
					</div>
				</div>
			</div>
			{error && (
				<div className="form-error" onClick={() => setError(null)}>
					{error}
				</div>
			)}
			<SectionHeading>MCP accounts — tools as yourself</SectionHeading>
			{servers === null ? (
				<div className="loading">Checking connections…</div>
			) : oauthServers.length === 0 ? (
				<div className="rounded-lg border border-line bg-panel px-4 py-3 text-xs text-dim">
					No OAuth-capable MCP servers configured yet — add one on the
					Connections page and it shows up here.
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border border-line bg-panel">
					{oauthServers.map((s, i) => {
						const st = oauthByName[s.name];
						const mine = st?.users.some(isMe);
						return (
							<div
								key={s.name}
								className={cn(
									"flex items-center gap-3 px-4 py-3",
									i > 0 && "border-t border-line",
								)}
							>
								<IconTile name={s.name} size={30} />
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-fg">
										{displayName(s.name)}
									</div>
									<div className="text-xs leading-snug text-dim">
										{mine
											? "Connected as you — your sessions use your account"
											: st?.shared
												? "Using the workspace account — connect yours so sessions act as you"
												: st?.capable
													? "Using the workspace key — connect your own account to act as you"
													: "Not connected — sign in to use these tools as yourself"}
									</div>
								</div>
								{mine ? (
									<button
										className="flex-shrink-0 rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-dim transition-colors hover:border-faint hover:text-fg"
										onClick={() => disconnect(s.name)}
									>
										Disconnect
									</button>
								) : (
									<button
										className="flex-shrink-0 rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-white transition-[filter] hover:brightness-105"
										onClick={() => connect(s.name)}
									>
										Connect
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
			<GithubAccounts personal />
		</div>
	);
}
