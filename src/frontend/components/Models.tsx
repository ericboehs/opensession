import React, { useEffect, useState, useCallback } from "react";
import { TEAM } from "./UserPicker";

// The Settings → Models panel: which model new sessions run on, plus the
// Claude / Codex account pools those runs draw from. Everything here follows
// the Settings idiom (setting-card row lists), not the Connections card grid.

interface ModelInfo {
	id: string;
	provider: "claude" | "codex";
	label: string;
	aliases: string[];
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
	usage: {
		fetchedAt: string;
		fiveHour: UsageWindow | null;
		sevenDay: UsageWindow | null;
		scopedLimits?: { label: string; utilization: number | null; resetsAt: string | null }[];
		error?: string;
		errorStatus?: number;
	} | null;
	noUsageScope: boolean;
	exhaustedUntil: string | null;
	usable: boolean;
}

interface CodexAccountInfo {
	id: string;
	name: string;
	kind: "api_key" | "home";
	valueMasked: string;
	createdAt: string;
	exhaustedUntil: string | null;
	usable: boolean;
}

export function ModelsPanel() {
	return (
		<div className="settings-panel">
			<h1 className="settings-title">Models</h1>

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
		fetch("/backstage/api/models")
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
			const res = await fetch("/backstage/api/models/default", {
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

	const claudeModels = (models || []).filter((m) => m.provider === "claude");
	const codexModels = (models || []).filter((m) => m.provider === "codex");

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
					{claudeModels.length > 0 && (
						<optgroup label="Claude">
							{claudeModels.map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</optgroup>
					)}
					{codexModels.length > 0 && (
						<optgroup label="Codex">
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
		fetch("/backstage/api/models")
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
			const res = await fetch("/backstage/api/models/auto-fallback", {
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
						"When a model runs out of usage credits, keep the session going on another model (Fable → Sonnet, otherwise the cross-provider fallback) instead of stopping. Off = the run halts and you pick the next model. Either way the switch shows in the chat."}
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
	return `resets ${d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
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

// ── Claude accounts ────────────────────────────────────────────────────────

/** The one pill that matters most — never stacked, so nothing collides. */
function ClaudeStatusPill({ a }: { a: ClaudeAccountInfo }) {
	if (a.usage?.error && a.usage.errorStatus === 401)
		return (
			<span className="status-pill status-red" title={a.usage.error}>
				Token error
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
				? await fetch("/backstage/api/claude-accounts/refresh", { method: "POST" })
				: await fetch("/backstage/api/claude-accounts");
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
			const res = await fetch(`/backstage/api/claude-accounts/${encodeURIComponent(a.id)}`, {
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
			const res = await fetch(`/backstage/api/claude-accounts/${encodeURIComponent(a.id)}`, {
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

	return (
		<>
			<SectionHeader
				label="Claude accounts"
				actions={
					<>
						<button className="btn-small" onClick={() => load(true)} disabled={refreshing}>
							{refreshing ? "Checking…" : "↻ Refresh usage"}
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
								{a.noUsageScope ? (
									<div className="text-faint text-[11.5px] mt-1.5">
										Usage not visible — setup-tokens can't read the usage endpoint. Runs
										work fine.
									</div>
								) : (
									<>
										<UsageBar label="5h" window={a.usage?.fiveHour ?? null} />
										<UsageBar label="7d" window={a.usage?.sevenDay ?? null} />
										{(a.usage?.scopedLimits ?? []).map((s) => (
											<UsageBar key={s.label} label={s.label} window={s} />
										))}
										{a.usage?.error && (
											<div className="text-red text-[11.5px] mt-1.5">{a.usage.error}</div>
										)}
									</>
								)}
							</div>
							<div className="setting-row-control flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-2">
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
								<button
									className="btn-small btn-small-danger"
									onClick={() => handleRemove(a)}
									title="Remove this account"
								>
									Remove
								</button>
							</div>
						</div>
					))
				)}
			</div>
			<div className="settings-hint">
				The usage pool for Claude session runs — each run picks the least-used usable account.
				A personal account is used first by its owner's runs and never by anyone else's;
				automations only use the shared pool.
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
			const res = await fetch("/backstage/api/codex-accounts");
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
	}, []);

	useEffect(() => {
		load();
		const t = setInterval(() => load(), 60_000);
		return () => clearInterval(t);
	}, [load]);

	async function handleRemove(a: CodexAccountInfo) {
		if (!confirm(`Remove Codex account "${a.name}"? Runs will stop using it.`)) return;
		try {
			const res = await fetch(`/backstage/api/codex-accounts/${encodeURIComponent(a.id)}`, {
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
							<div className="setting-row-control">
								<button
									className="btn-small btn-small-danger"
									onClick={() => handleRemove(a)}
									title="Remove this account"
								>
									Remove
								</button>
							</div>
						</div>
					))
				)}
			</div>
			<div className="settings-hint">
				The pool for GPT/Codex session runs — runs rotate to the next account when one hits its
				usage limit.
			</div>
		</>
	);
}

// ── Add forms ──────────────────────────────────────────────────────────────

function AddClaudeAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [owner, setOwner] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch("/backstage/api/claude-accounts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// Strip all whitespace — CLI copies often carry line-wrap newlines.
					token: token.replace(/\s+/g, ""),
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

	return (
		<div className="automation-form" style={{ marginBottom: 12 }}>
			<div className="automation-form-title">Add Claude account</div>
			<div className="setting-row-desc" style={{ marginTop: -8 }}>
				On any machine, log into the Max account with <code>claude</code>, run{" "}
				<code>claude setup-token</code>, and paste the one-year token here. It's stored on the
				VPS (0600) and only ever shown masked.
			</div>

			<div className="automation-form-row">
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="tella-dev" />
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

function AddCodexAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"api_key" | "home">("home");
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleAdd() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch("/backstage/api/codex-accounts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.trim(), kind, value: value.trim() }),
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
			<div className="automation-form-title">Add Codex account</div>
			<div className="setting-row-desc" style={{ marginTop: -8 }}>
				For a ChatGPT plan: on the VPS run{" "}
				<code>CODEX_HOME=~/.codex-accounts/&lt;name&gt; codex login</code>, then register that
				directory here. For platform billing, paste an OpenAI API key instead.
			</div>

			<div className="automation-form-row">
				<label>
					Name
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="tella-dev" />
				</label>
				<label>
					Kind
					<select value={kind} onChange={(e) => setKind(e.target.value as "api_key" | "home")}>
						<option value="home">ChatGPT login — CODEX_HOME directory</option>
						<option value="api_key">OpenAI API key</option>
					</select>
				</label>
				<label>
					{kind === "api_key" ? "API key" : "CODEX_HOME path"}
					<input
						className="mono-input"
						type={kind === "api_key" ? "password" : "text"}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={kind === "api_key" ? "sk-…" : "/home/ubuntu/.codex-accounts/tella-dev"}
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
					disabled={saving || !name.trim() || !value.trim()}
				>
					{saving ? "Adding…" : "Add account"}
				</button>
			</div>
		</div>
	);
}
