import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState, useCallback } from "react";
import { TEAM } from "./UserPicker";
import { shortModelLabel, splitModelOptions } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { IconDotsHorizontal, IconSliders, IconTrash } from "./icons";

// The Settings → Accounts panel: the Claude / Codex subscription accounts
// session runs draw from, plus the default model new runs start on. Everything
// here follows the Settings idiom (setting-card row lists), not the
// Connections card grid.

interface ModelInfo {
	id: string;
	provider: "claude" | "codex" | "opencode";
	label: string;
	aliases: string[];
	efforts: string[];
}

interface UsageWindow {
	utilization: number | null;
	resetsAt: string | null;
}

interface ClaudeAccountInfo {
	id: string;
	name: string;
	tokenMasked: string;
	email?: string;
	plan?: string;
	/** Personal sub of this person; unset = shared pool account. */
	owner?: string;
	mode: "shared" | "personal";
	usage: {
		fetchedAt: string;
		fiveHour: UsageWindow | null;
		sevenDay: UsageWindow | null;
		scopedLimits?: { label: string; utilization: number | null; resetsAt: string | null }[];
		/** Pay-as-you-go spend past the subscription limits; credits are cents. */
		extraUsage?: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null;
		/** "meridian" = observed via a live Meridian proxy, not the OAuth endpoint. */
		source?: "meridian";
		error?: string;
		errorStatus?: number;
	} | null;
	noUsageScope: boolean;
	credentialsPath?: string;
	exhaustedUntil: string | null;
	usable: boolean;
}

interface CodexAccountInfo {
	id: string;
	name: string;
	kind: "api_key" | "home";
	valueMasked: string;
	owner?: string;
	mode: "shared" | "personal";
	createdAt: string;
	exhaustedUntil: string | null;
	usable: boolean;
}

export function AccountsPanel() {
	return (
		<div className="settings-panel">
			<h1 className="settings-title">Accounts</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				The Claude (Anthropic) and Codex (OpenAI) subscription accounts that
				session runs draw from, plus the model new runs start on. Other model
				providers with their own API keys live under Model providers.
			</div>

			<div className="settings-group-label">Default model</div>
			<div className="setting-card">
				<DefaultModelRow />
				<AutoFallbackRow />
			</div>

			<ClaudeAccountsSection />
			<CodexAccountsSection />

			<div className="settings-hint">
				Changes apply to new session runs immediately (config is read per run) — no restart
				needed. Per-session model overrides still win over the default.
			</div>
		</div>
	);
}

// ── Default model ──────────────────────────────────────────────────────────

function DefaultModelRow() {
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string>("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (!body) return;
				setModels(body.models);
				setCurrent(body.default);
			})
			.catch(() => {});
	}, []);

	async function handleChange(id: string) {
		if (id === current) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/models/default`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setCurrent(body.default);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	// Opencode entries are the first-class list (friendly names, no engine
	// noise); the native claude/codex entries stay selectable under
	// de-emphasized legacy groups while the migration lands.
	const { opencode: opencodeModels, legacy } = splitModelOptions(models || []);
	const claudeModels = legacy.filter((m) => m.provider === "claude");
	const codexModels = legacy.filter((m) => m.provider === "codex");
	const legacyGroup = (engine: string) =>
		opencodeModels.length > 0 ? `Legacy — ${engine} (direct SDK)` : engine;

	return (
		<div className="setting-row">
			<div className="setting-row-text">
				<div className="setting-row-title">What new sessions run on</div>
				<div className="setting-row-desc">
					{error ||
						"Sessions and agent runs (Slack, Linear, Plain, automations without their own model) start on this."}
				</div>
			</div>
			<div className="setting-row-control">
				<select
					className="ui-select"
					value={current}
					disabled={!models || saving}
					onChange={(e) => handleChange(e.target.value)}
					aria-label="Default model"
				>
					{opencodeModels.map((m) => (
						<option key={m.id} value={m.id}>
							{shortModelLabel(m.id, models || [])}
						</option>
					))}
					{claudeModels.length > 0 && (
						<optgroup label={legacyGroup("Claude")}>
							{claudeModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</optgroup>
					)}
					{codexModels.length > 0 && (
						<optgroup label={legacyGroup("Codex")}>
							{codexModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</optgroup>
					)}
				</select>
			</div>
		</div>
	);
}

// ── Auto model-switch on out-of-credits ─────────────────────────────────────

/**
 * Manual vs auto: when a session's model runs out of usage credits pool-wide,
 * either drop it to a fallback model and keep going (auto, the default) or stop
 * on the limit notice and let the human pick the next model (manual). Global,
 * read fresh per run. The switch is always announced in the chat as a divider.
 */
function AutoFallbackRow() {
	const [auto, setAuto] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setAuto(body.autoFallback !== false))
			.catch(() => {});
	}, []);

	async function toggle(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		const prev = auto;
		setAuto(next); // optimistic
		try {
			const res = await fetch(`${BASE_PATH}/api/models/auto-fallback`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ auto: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setAuto(body.autoFallback);
		} catch (e: any) {
			setError(e.message);
			setAuto(prev ?? null);
		}
		setSaving(false);
	}

	const on = auto ?? true;
	return (
		<div className="setting-row">
			<div className="setting-row-text">
				<div className="setting-row-title">Auto-switch when out of credits</div>
				<div className="setting-row-desc">
					{error ||
						"When a run has an explicit fallback model and the current model runs out of usage credits, keep going on that configured fallback. Off = the run halts and you pick the next model. Either way the switch shows in the chat."}
				</div>
			</div>
			<div className="setting-row-control">
				<button
					role="switch"
					aria-checked={on}
					aria-label="Auto-switch model when out of credits"
					className={`ui-switch ${on ? "on" : ""}`}
					disabled={auto === null || saving}
					onClick={() => toggle(!on)}
				>
					<span className="ui-switch-knob" />
				</button>
			</div>
		</div>
	);
}

// ── Shared bits ────────────────────────────────────────────────────────────

/** Group heading with right-aligned actions (Refresh / Add). */
function SectionHeader({
	label,
	actions,
}: {
	label: string;
	actions: React.ReactNode;
}) {
	return (
		<div className="settings-group-label flex items-center justify-between gap-2">
			<span>{label}</span>
			<div className="flex items-center gap-1.5">{actions}</div>
		</div>
	);
}

/** ⋯ trigger for a row's overflow actions — always visible (setting rows have
 * no hover-group), lights up while its menu is open. */
const rowMenuTriggerClasses =
	"flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint transition-[color,background] hover:bg-active hover:text-fg data-[popup-open]:bg-active data-[popup-open]:text-fg";

function Avatar({ name, className }: { name: string; className: string }) {
	return (
		<span
			className={`w-7 h-7 rounded-md text-white font-bold text-[13px] inline-flex items-center justify-center shrink-0 ${className}`}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

function formatReset(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	if (isNaN(d.getTime())) return "";
	return `resets ${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function UsageBar({ label, window: w }: { label: string; window: UsageWindow | null }) {
	const pct = w?.utilization ?? null;
	const tone = pct === null ? "gray" : pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
	return (
		<div className="acct-usage-row">
			<span className="acct-usage-label">{label}</span>
			<div className="acct-usage-bar">
				<div
					className={`acct-usage-fill acct-usage-${tone}`}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>
			<span className="acct-usage-pct">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
			<span className="acct-usage-reset">{formatReset(w?.resetsAt ?? null)}</span>
		</div>
	);
}

/**
 * Usage-credits (extra usage) spend for one account: what's been billed past
 * the subscription's included limits this month, against the account's monthly
 * credit cap. Values from the OAuth usage endpoint are cents. Hidden when the
 * account has extra usage off and nothing spent — most accounts, most months.
 */
function ExtraUsageRow({
	extra,
}: {
	extra: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null | undefined;
}) {
	if (!extra || (!extra.enabled && extra.usedCredits <= 0)) return null;
	const usd = (cents: number) =>
		`$${(cents / 100).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const pct = extra.monthlyLimit > 0 ? (extra.usedCredits / extra.monthlyLimit) * 100 : null;
	const tone = pct === null ? "gray" : pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
	return (
		<div className="acct-usage-row" title="Usage-credits — pay-as-you-go spend past the subscription limits, against this account's monthly credit cap (set at claude.ai)">
			<span className="acct-usage-label">Credits</span>
			<div className="acct-usage-bar">
				<div
					className={`acct-usage-fill acct-usage-${tone}`}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>
			<span className="acct-usage-pct">{usd(extra.usedCredits)}</span>
			<span className="acct-usage-reset">
				{extra.monthlyLimit > 0 ? `of ${usd(extra.monthlyLimit)}/mo` : "no monthly cap set"}
				{extra.enabled ? "" : " · off"}
			</span>
		</div>
	);
}

// ── Claude accounts ────────────────────────────────────────────────────────

/** The one pill that matters most — never stacked, so nothing collides. */
function ClaudeStatusPill({ a }: { a: ClaudeAccountInfo }) {
	if (a.usage?.error && a.usage.errorStatus === 401)
		return (
			<span className="status-pill status-red" title={a.usage.error}>
				Token error
			</span>
		);
	if (a.usage?.error)
		return (
			<span className="status-pill status-yellow" title={a.usage.error}>
				Usage unknown
			</span>
		);
	if (a.noUsageScope && !a.usage)
		return (
			<span className="status-pill status-yellow" title="Add OAuth usage credentials to show dashboard usage.">
				Usage hidden
			</span>
		);
	if (a.exhaustedUntil)
		return (
			<span className="status-pill status-red" title={`Sidelined until ${a.exhaustedUntil}`}>
				Limit hit
			</span>
		);
	if (a.usable) return <span className="status-pill status-green">In rotation</span>;
	return <span className="status-pill status-yellow">Near limit</span>;
}

function ClaudeAccountsSection() {
	const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (forceUsage = false) => {
		if (forceUsage) setRefreshing(true);
		try {
			const res = forceUsage
				? await fetch(`${BASE_PATH}/api/claude-accounts/refresh`, { method: "POST" })
				: await fetch(`${BASE_PATH}/api/claude-accounts`);
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
		setRefreshing(false);
	}, []);

	useEffect(() => {
		load();
		const t = setInterval(() => load(), 60_000);
		return () => clearInterval(t);
	}, [load]);

	async function handleRemove(a: ClaudeAccountInfo) {
		if (!confirm(`Remove Claude account "${a.name}"? Runs will stop using its token.`)) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "DELETE",
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleSetOwner(a: ClaudeAccountInfo, owner: string) {
		if (owner === (a.owner || "")) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleSetCredentialsPath(a: ClaudeAccountInfo) {
		const current =
			a.credentialsPath ||
			`/home/ubuntu/.claude/accounts/${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/credentials.json`;
		const credentialsPath = prompt(
			"Path to this account's Claude OAuth credentials.json for usage polling. Leave empty to clear it.",
			current,
		);
		if (credentialsPath === null) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner: a.owner || "", credentialsPath }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load(true);
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<>
			<SectionHeader
				label="Claude accounts"
				actions={
					<>
						<button className="btn-small" onClick={() => load(true)} disabled={refreshing}>
							{refreshing ? "Checking…" : "Refresh usage"}
						</button>
						<button className="btn-small" onClick={() => setShowAdd(true)}>
							+ Add account
						</button>
					</>
				}
			/>

			{error && (
				<div className="form-error mb-2" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			{showAdd && (
				<AddClaudeAccountForm
					onClose={() => setShowAdd(false)}
					onAdded={() => {
						setShowAdd(false);
						load();
					}}
				/>
			)}

			<div className="setting-card">
				{!accounts ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">Loading accounts…</div>
				) : accounts.length === 0 ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">
						No accounts yet — runs use the VPS's own Claude login. Add Max-account tokens
						(<code>claude setup-token</code>) and runs pick the least-used one, rotating when
						one hits its limit.
					</div>
				) : (
					accounts.map((a) => (
						<div key={a.id} className="setting-row">
							<Avatar name={a.name} className="bg-[#d97757]" />
							<div className="setting-row-text">
								<div className="flex items-center gap-2 min-w-0">
									<span className="setting-row-title truncate">{a.name}</span>
									<ClaudeStatusPill a={a} />
								</div>
								<div className="setting-row-desc truncate">
									{a.email || "unknown email"}
									{a.plan ? ` · ${a.plan.replace("default_claude_", "")}` : ""}
									{" · "}
									<span className="font-mono">{a.tokenMasked}</span>
								</div>
								{a.noUsageScope && !a.usage ? (
									<div className="text-faint text-[11.5px] mt-1.5">
										Usage not visible — setup-tokens cannot read the usage endpoint. Add
										a Claude OAuth credentials path for this account to show usage.
									</div>
								) : (
									<>
										<UsageBar label="5h" window={a.usage?.fiveHour ?? null} />
										<UsageBar label="7d" window={a.usage?.sevenDay ?? null} />
										{(a.usage?.scopedLimits ?? []).map((s) => (
											<UsageBar key={s.label} label={s.label} window={s} />
										))}
										<ExtraUsageRow extra={a.usage?.extraUsage} />
										{a.usage?.source === "meridian" && (
											<div className="text-faint text-[11.5px] mt-1.5">
												Observed via the Meridian bridge (rate-limit events from live
												runs) — the token can’t read the usage endpoint directly.
											</div>
										)}
										{a.usage?.error && (
											<div className="text-red text-[11.5px] mt-1.5">{a.usage.error}</div>
										)}
										{a.credentialsPath && (
											<div className="text-faint text-[11.5px] mt-1.5 truncate">
												Usage credentials: <code>{a.credentialsPath}</code>
											</div>
										)}
									</>
								)}
							</div>
							<div className="setting-row-control flex items-center gap-1.5">
								<select
									className="ui-select"
									value={a.owner || ""}
									onChange={(e) => handleSetOwner(a, e.target.value)}
									aria-label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal sub — their runs use it first, everyone else never does.`
											: "Shared pool account — used by everyone and by automations."
									}
								>
									<option value="">Shared pool</option>
									{/* Keep a non-team owner (e.g. set via API) selectable. */}
									{a.owner && !TEAM.includes(a.owner) && (
										<option value={a.owner}>👤 {a.owner}</option>
									)}
									{TEAM.map((name) => (
										<option key={name} value={name}>
											👤 {name}
										</option>
									))}
								</select>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${a.name}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item onClick={() => handleSetCredentialsPath(a)}>
											<IconSliders size={16} className="text-faint" />
											Usage credentials…
										</Menu.Item>
										<Menu.Item
											onClick={() => handleRemove(a)}
											className="text-red data-[highlighted]:bg-red-soft"
										>
											<IconTrash size={16} />
											Remove account
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							</div>
						</div>
					))
				)}
			</div>
			<div className="settings-hint">
				The usage pool for Claude session runs — each run picks the least-used usable account.
				A personal account is used first by its owner's runs and never by anyone else's;
				automations only use the shared pool. For usage bars, setup-tokens need a matching
				OAuth snapshot such as <code>~/.claude/accounts/team/credentials.json</code>.
				If that snapshot expires and cannot refresh, log into that account with <code>claude</code>
				or <code>claude-plan auth</code> again and update the path.
			</div>
		</>
	);
}

// ── Codex accounts ─────────────────────────────────────────────────────────

function CodexAccountsSection() {
	const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts`);
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
	}, []);

	useEffect(() => {
		load();
		const t = setInterval(() => load(), 60_000);
		return () => clearInterval(t);
	}, [load]);

	async function handleSetOwner(a: CodexAccountInfo, owner: string) {
		if (owner === (a.owner || "")) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(a.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ owner }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	async function handleRemove(a: CodexAccountInfo) {
		if (!confirm(`Remove Codex account "${a.name}"? Runs will stop using it.`)) return;
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/${encodeURIComponent(a.id)}`, {
				method: "DELETE",
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			load();
		} catch (e: any) {
			setError(e.message);
		}
	}

	return (
		<>
			<SectionHeader
				label="Codex accounts"
				actions={
					<button className="btn-small" onClick={() => setShowAdd(true)}>
						+ Add account
					</button>
				}
			/>

			{error && (
				<div className="form-error mb-2" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			{showAdd && (
				<AddCodexAccountForm
					onClose={() => setShowAdd(false)}
					onAdded={() => {
						setShowAdd(false);
						load();
					}}
				/>
			)}

			<div className="setting-card">
				{!accounts ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">Loading accounts…</div>
				) : accounts.length === 0 ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">
						No accounts yet — Codex runs use the VPS's own <code>codex login</code> (~/.codex).
						Add an OpenAI API key, or a CODEX_HOME directory holding a ChatGPT-plan{" "}
						<code>auth.json</code>, and runs rotate across the pool.
					</div>
				) : (
					accounts.map((a) => (
						<div key={a.id} className="setting-row">
							<Avatar name={a.name} className="bg-[#10a37f]" />
							<div className="setting-row-text">
								<div className="flex items-center gap-2 min-w-0">
									<span className="setting-row-title truncate">{a.name}</span>
									{a.exhaustedUntil ? (
										<span
											className="status-pill status-red"
											title={`Sidelined until ${a.exhaustedUntil}`}
										>
											Limit hit
										</span>
									) : (
										<span className="status-pill status-green">In rotation</span>
									)}
								</div>
								<div className="setting-row-desc truncate">
									{a.kind === "api_key" ? "API key" : "ChatGPT login"}
									{" · "}
									<span className="font-mono">{a.valueMasked}</span>
								</div>
							</div>
							<div className="setting-row-control flex items-center gap-1.5">
								<select
									className="ui-select"
									value={a.owner || ""}
									onChange={(e) => handleSetOwner(a, e.target.value)}
									aria-label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal subscription — their runs use it first, everyone else never does.`
											: "Shared pool account — used by everyone and by automations."
									}
								>
									<option value="">Shared pool</option>
									{/* Keep a non-team owner (e.g. set via API) selectable. */}
									{a.owner && !TEAM.includes(a.owner) && (
										<option value={a.owner}>👤 {a.owner}</option>
									)}
									{TEAM.map((name) => (
										<option key={name} value={name}>
											👤 {name}
										</option>
									))}
								</select>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${a.name}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item
											onClick={() => handleRemove(a)}
											className="text-red data-[highlighted]:bg-red-soft"
										>
											<IconTrash size={16} />
											Remove account
										</Menu.Item>
									</Menu.Popup>
								</Menu.Root>
							</div>
						</div>
					))
				)}
			</div>
			<div className="settings-hint">
				The pool for GPT/Codex session runs — runs rotate to the next account when one hits its
				usage limit. A personal account is used first by its owner's runs and never by anyone
				else's; automations only use the shared pool.
			</div>
		</>
	);
}

// ── Add forms ──────────────────────────────────────────────────────────────

function AddClaudeAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [owner, setOwner] = useState("");
	const [credentialsPath, setCredentialsPath] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/claude-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// Strip all whitespace — CLI copies often carry line-wrap newlines.
					token: token.replace(/\s+/g, ""),
					...(owner.trim() ? { owner: owner.trim() } : {}),
					...(credentialsPath.trim() ? { credentialsPath: credentialsPath.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			onAdded();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	return (
		<div className="automation-form" style={{ marginBottom: 12 }}>
			<div className="automation-form-title">Add Claude account</div>
			<div className="setting-row-desc" style={{ marginTop: -8 }}>
				On any machine, log into the Max account with <code>claude</code>, run{" "}
				<code>claude setup-token</code>, and paste the one-year token here. It's stored on the
				VPS (0600) and only ever shown masked. To show usage, also point at that account's
				<code> credentials.json</code> snapshot from <code>~/.claude/accounts</code>.
			</div>

			<div className="automation-form-row">
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="team" />
				</label>
				<label>
					Token
					<input
						className="mono-input"
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder="sk-ant-oat01-…"
					/>
				</label>
				<label title="Personal sub: this person's runs use the account first, with the shared pool as backup — nobody else's runs touch it. Shared pool = used by everyone and by automations.">
					Owner
					<select value={owner} onChange={(e) => setOwner(e.target.value)}>
						<option value="">Shared pool</option>
						{TEAM.map((n) => (
							<option key={n} value={n}>
								👤 {n}
							</option>
						))}
					</select>
				</label>
				<label>
					Usage credentials path
					<input
						className="mono-input"
						value={credentialsPath}
						onChange={(e) => setCredentialsPath(e.target.value)}
						placeholder="~/.claude/accounts/team/credentials.json"
					/>
				</label>
			</div>

			{error && <div className="form-error">{error}</div>}

			<div className="automation-form-actions">
				<button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
					Cancel
				</button>
				<button
					className="btn-create"
					style={{ padding: "8px 22px" }}
					onClick={handleAdd}
					disabled={saving || !name.trim() || !token.trim()}
				>
					{saving ? "Validating…" : "Add account"}
				</button>
			</div>
		</div>
	);
}

interface CodexDeviceLogin {
	id: string;
	name: string;
	state: "starting" | "awaiting_code" | "done" | "error" | "cancelled";
	url?: string;
	code?: string;
	error?: string;
}

function AddCodexAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"device" | "api_key" | "home">("device");
	const [value, setValue] = useState("");
	const [owner, setOwner] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [login, setLogin] = useState<CodexDeviceLogin | null>(null);

	// Poll an in-flight device sign-in until it lands (or fails).
	useEffect(() => {
		if (!login || login.state === "done" || login.state === "error") return;
		const t = setInterval(async () => {
			try {
				const res = await fetch(
					`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(login.id)}`
				);
				if (!res.ok) return;
				const next: CodexDeviceLogin = await res.json();
				setLogin(next);
				if (next.state === "done") onAdded();
			} catch {}
		}, 2000);
		return () => clearInterval(t);
	}, [login?.id, login?.state]);

	async function handleStartDeviceLogin() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/device-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setLogin(body);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	function handleCancel() {
		if (login && (login.state === "starting" || login.state === "awaiting_code")) {
			fetch(`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(login.id)}`, {
				method: "DELETE",
			}).catch(() => {});
		}
		onClose();
	}

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					kind,
					value: value.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			onAdded();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	const loginPending = login && (login.state === "starting" || login.state === "awaiting_code");

	return (
		<div className="automation-form" style={{ marginBottom: 12 }}>
			<div className="automation-form-title">Add Codex account</div>
			<div className="setting-row-desc" style={{ marginTop: -8 }}>
				{kind === "device" ? (
					<>
						Sign in with ChatGPT from here — no VPS access needed. You'll get a link and a
						one-time code to enter on any device. (Device-code login must be enabled in the
						ChatGPT workspace's security settings.)
					</>
				) : kind === "home" ? (
					<>
						On the VPS run <code>CODEX_HOME=~/.codex-accounts/&lt;name&gt; codex login</code>{" "}
						(or copy an <code>auth.json</code> from another machine into that directory),
						then register the directory here.
					</>
				) : (
					<>For platform billing, paste an OpenAI API key.</>
				)}
			</div>

			<div className="automation-form-row">
				<label>
					Name
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="team"
						disabled={!!login}
					/>
				</label>
				<label>
					Kind
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as "device" | "api_key" | "home")}
						disabled={!!login}
					>
						<option value="device">ChatGPT sign-in — device code</option>
						<option value="home">ChatGPT login — existing CODEX_HOME directory</option>
						<option value="api_key">OpenAI API key</option>
					</select>
				</label>
				{kind !== "device" && (
					<label>
						{kind === "api_key" ? "API key" : "CODEX_HOME path"}
						<input
							className="mono-input"
							type={kind === "api_key" ? "password" : "text"}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder={kind === "api_key" ? "sk-…" : "~/.codex-accounts/team"}
						/>
					</label>
				)}
				<label title="Personal sub: this person's runs use the account first, with the shared pool as backup — nobody else's runs touch it. Shared pool = used by everyone and by automations.">
					Owner
					<select value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!!login}>
						<option value="">Shared pool</option>
						{TEAM.map((n) => (
							<option key={n} value={n}>
								👤 {n}
							</option>
						))}
					</select>
				</label>
			</div>

			{login && (
				<div className="setting-card" style={{ marginTop: 8, padding: "12px 16px" }}>
					{login.state === "starting" && (
						<div className="text-dim text-[12.5px]">Starting sign-in…</div>
					)}
					{login.state === "awaiting_code" && (
						<>
							<div className="text-[12.5px]" style={{ marginBottom: 6 }}>
								1. Open{" "}
								<a href={login.url} target="_blank" rel="noreferrer">
									{login.url}
								</a>{" "}
								and sign in to the ChatGPT account.
							</div>
							<div className="text-[12.5px]">2. Enter this one-time code (expires in 15 min):</div>
							<div
								className="font-mono"
								style={{ fontSize: 22, letterSpacing: 2, margin: "8px 0 4px" }}
							>
								{login.code}
							</div>
							<div className="text-dim text-[12.5px]">
								Waiting for the sign-in to complete… this panel updates by itself.
							</div>
						</>
					)}
					{login.state === "done" && (
						<div className="text-[12.5px]">Signed in — account "{login.name}" added to the pool.</div>
					)}
					{login.state === "error" && (
						<div className="form-error" style={{ whiteSpace: "pre-wrap" }}>
							{login.error || "Sign-in failed."}{" "}
							<button className="btn-small" onClick={() => setLogin(null)} style={{ marginLeft: 8 }}>
								Try again
							</button>
						</div>
					)}
				</div>
			)}

			{error && <div className="form-error">{error}</div>}

			<div className="automation-form-actions">
				<button className="btn-delete-cancel" onClick={handleCancel} disabled={saving}>
					{loginPending ? "Cancel sign-in" : "Cancel"}
				</button>
				{kind === "device" ? (
					<button
						className="btn-create"
						style={{ padding: "8px 22px" }}
						onClick={handleStartDeviceLogin}
						disabled={saving || !name.trim() || !!loginPending || login?.state === "done"}
					>
						{saving ? "Starting…" : loginPending ? "Waiting for sign-in…" : "Start sign-in"}
					</button>
				) : (
					<button
						className="btn-create"
						style={{ padding: "8px 22px" }}
						onClick={handleAdd}
						disabled={saving || !name.trim() || !value.trim()}
					>
						{saving ? "Adding…" : "Add account"}
					</button>
				)}
			</div>
		</div>
	);
}
