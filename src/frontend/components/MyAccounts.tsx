import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsPanel,
} from "../ui/settings";
import { IconTile, displayName } from "./BrandTile";
import { useCurrentUser } from "./UserPicker";
import { GithubAccounts } from "./Connections";

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
		<SettingsPanel>
			<div className="mb-[22px]">
				<div>
					<h2 className="m-0 px-2.5 text-[19px] font-semibold tracking-[-0.01em] text-fg">
						My accounts
					</h2>
					<div className="mt-1 px-2.5 text-[12.5px] text-faint">
						Your personal sign-ins. Sessions act as you where you're
						connected; otherwise they fall back to the workspace account.
					</div>
				</div>
			</div>
			{error && (
				<InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
			)}
			<SettingsGroupLabel>MCP accounts — tools as yourself</SettingsGroupLabel>
			{servers === null ? (
				<LoadingState>Checking connections…</LoadingState>
			) : oauthServers.length === 0 ? (
				<EmptyState placement="card">
					No OAuth-capable MCP servers configured yet — add one on the
					Connections page and it shows up here.
				</EmptyState>
			) : (
				<SettingCard>
					{oauthServers.map((s) => {
						const st = oauthByName[s.name];
						const mine = st?.users.some(isMe);
						return (
							<SettingRow
								key={s.name}
								className="gap-3 py-3"
							>
								<IconTile name={s.name} size={30} />
								<SettingRowText>
									<SettingRowTitle className="text-sm">
										{displayName(s.name)}
									</SettingRowTitle>
									<SettingRowDescription className="mt-0 text-xs leading-snug">
										{mine
											? "Connected as you — your sessions use your account"
											: st?.shared
												? "Using the workspace account — connect yours so sessions act as you"
												: st?.capable
													? "Using the workspace key — connect your own account to act as you"
													: "Not connected — sign in to use these tools as yourself"}
									</SettingRowDescription>
								</SettingRowText>
								<SettingRowControl>
									{mine ? (
										<Button
											size="sm"
											className="min-h-[30px] px-3 text-[13px]"
											onClick={() => disconnect(s.name)}
										>
											Disconnect
										</Button>
									) : (
										<Button
											variant="primary"
											size="sm"
											className="min-h-[30px] px-3 text-[13px]"
											onClick={() => connect(s.name)}
										>
											Connect
										</Button>
									)}
								</SettingRowControl>
							</SettingRow>
						);
					})}
				</SettingCard>
			)}
			<GithubAccounts personal />
		</SettingsPanel>
	);
}
