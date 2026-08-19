import { BASE_PATH } from "../../lib/base";
import React, { useEffect, useRef, useState, useCallback, type RefObject } from "react";
import { usePeople } from "../../lib/people";
import { UserAvatar } from "../UserAvatar";
import {
	claudeLimits,
	liveLimits,
	type LimitWindow,
	type UsageWindow,
} from "../../lib/account-usage";
import { Field, Input } from "../../ui/input";
import { Menu } from "../../ui/menu";
import { Modal } from "../../ui/modal";
import { Select } from "../../ui/select";
import { Button } from "../../ui/button";
import { DeviceCode } from "../../ui/device-code";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
	rowMenuTriggerClasses,
} from "../../ui/settings";
import { cn } from "../../ui/cn";
import { toast } from "../../ui/toast";
import {
	IconDotsHorizontal,
	IconHistory,
	IconPeople,
	IconPlug,
	IconPlus,
	IconSliders,
	IconTrash,
} from "../icons";

// The Claude and Codex subscription accounts runs draw from, and how full each
// one is. Rendered by Settings → Usage; the account list and its meters live
// together because the answer to "this one is spent" is an action on the row
// (hand it an owner, connect its usage, take it out of the pool).

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
	usage: {
		fetchedAt: string;
		buckets: CodexUsageBucket[];
		resetCreditsAvailable: number | null;
		error?: string;
	} | null;
}

interface CodexUsageBucket {
	id: string;
	label?: string;
	plan?: string;
	primary: (UsageWindow & { windowDurationMins: number | null }) | null;
	secondary: (UsageWindow & { windowDurationMins: number | null }) | null;
	rateLimitReachedType?: string;
}

// ── Shared bits ────────────────────────────────────────────────────────────

/** Who an account belongs to: the shared pool, or one person's own
 *  subscription. Both account lists render this same row control. */
function OwnerSelect({
	value,
	onChange,
	label,
	title,
	disabled,
}: {
	value: string;
	onChange: (owner: string) => void;
	label: string;
	title?: string;
	disabled?: boolean;
}) {
	// The roster reactively, so the list and the pictures both fill in when
	// GET /api/people lands rather than only on the next render.
	const roster = usePeople().map((p) => p.name);
	// Keep a non-team owner (e.g. set via the API) selectable.
	const owners = value && !roster.includes(value) ? [value, ...roster] : roster;
	const items = [
		{ value: "", label: "Shared pool" },
		...owners.map((name) => ({ value: name, label: name })),
	];
	// The person's own picture, the way every other people picker in the app
	// draws them. The pool is everyone, so it takes the group glyph.
	const ownerIcon = (owner: string) =>
		owner ? <UserAvatar name={owner} size={16} /> : <IconPeople size={16} />;
	return (
		<Select.Root
			items={items}
			value={value}
			disabled={disabled}
			onValueChange={(next) => onChange(String(next))}
		>
			<Select.Trigger
				aria-label={label}
				title={title}
				icon={ownerIcon(value)}
				sizeTo={items.map((i) => i.label)}
			/>
			<Select.Popup align="end">
				{items.map((i) => (
					<Select.Item key={i.value} value={i.value} icon={ownerIcon(i.value)}>
						{i.label}
					</Select.Item>
				))}
			</Select.Popup>
		</Select.Root>
	);
}

function Avatar({ name, className }: { name: string; className: string }) {
	return (
		<span
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-label font-bold text-white",
				className,
			)}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

/**
 * A meter's fill. Normal usage is neutral ink, not green: an account that is
 * fine already says so in its "In rotation" pill, and three green bars per
 * account across nine accounts turned the whole page into colour with nothing
 * to look at. Colour here means "this one is running out" — so the two
 * accounts near a limit are the only things that catch the eye.
 */
const usageToneClasses = {
	unknown: "bg-line",
	high: "bg-red",
	warn: "bg-yellow",
	normal: "bg-faint",
} as const;

/** Utilization → tone. Shared so a meter and its neighbours can't drift. */
function usageTone(pct: number | null): keyof typeof usageToneClasses {
	return pct === null ? "unknown" : pct >= 90 ? "high" : pct >= 70 ? "warn" : "normal";
}

const statusToneClasses = {
	red: "bg-red-soft text-red",
	yellow: "bg-[rgba(210,153,34,0.15)] text-yellow",
} as const;

function StatusPill({
	tone,
	children,
	...props
}: React.ComponentPropsWithoutRef<"span"> & { tone: keyof typeof statusToneClasses }) {
	return (
		<span
			className={cn(
				"inline-flex min-w-[70px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 py-[3px] text-meta font-bold phone:min-w-0 phone:px-2",
				statusToneClasses[tone],
			)}
			{...props}
		>
			{children}
		</span>
	);
}

/**
 * "resets in 3h". An account reports three or four windows, so the absolute
 * timestamp this used to print ("resets Sat, Aug 1, 05:00 PM") was repeated
 * down the whole page — the single noisiest thing on it, for the least useful
 * reading. What a person wants from a limit is how long until it frees up; the
 * exact time stays one hover away.
 */
function formatReset(resetsAt: string | null): string {
	const d = resetsAt ? new Date(resetsAt) : null;
	if (!d || isNaN(d.getTime())) return "";
	const mins = Math.round((d.getTime() - Date.now()) / 60_000);
	if (mins <= 0) return "resets now";
	if (mins < 60) return `resets in ${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `resets in ${hours}h`;
	return `resets in ${Math.round(hours / 24)}d`;
}

function absoluteReset(resetsAt: string | null): string | undefined {
	const d = resetsAt ? new Date(resetsAt) : null;
	if (!d || isNaN(d.getTime())) return undefined;
	return `Resets ${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The meters under an account share one grid, so bars and values line up down
 * their columns. Each row is two things, not four: what the limit is and when
 * it frees up on the left, how full it is on the right. The label column used
 * to be a fixed 46px, which truncated every Codex bucket to "Codex…" /
 * "GPT-5…", losing the one word that said which limit you were looking at.
 */
function MeterGroup({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-2 grid max-w-[420px] grid-cols-[minmax(0,1fr)_112px_minmax(42px,auto)] items-center gap-x-3 gap-y-1.5 text-meta phone:grid-cols-[minmax(0,1fr)_72px_minmax(38px,auto)] phone:gap-x-2">
			{children}
		</div>
	);
}

/** One row of MeterGroup's grid: label and note, bar, value. */
function Meter({
	label,
	labelTitle,
	pct,
	value,
	note,
	noteTitle,
}: {
	label: string;
	labelTitle?: string;
	/** 0-100, or null when the value is unknown — the track renders empty. */
	pct: number | null;
	value: React.ReactNode;
	note?: React.ReactNode;
	noteTitle?: string;
}) {
	return (
		<>
			{/* One line on desktop; on a phone the column is too narrow for
			    "Fable · resets in 5d", so it wraps rather than clipping the
			    reset time, which a touch device can't reveal with a tooltip. */}
			<span
				className="overflow-hidden text-ellipsis whitespace-nowrap text-dim phone:overflow-visible phone:whitespace-normal"
				title={labelTitle}
			>
				{label}
				{note ? (
					<span className="text-faint" title={noteTitle}>
						{" · "}
						{note}
					</span>
				) : null}
			</span>
			<div className="h-1.5 overflow-hidden rounded-full bg-active">
				<div
					className={cn(
						"h-full rounded-full transition-[width] duration-300",
						usageToneClasses[usageTone(pct)],
					)}
					style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
				/>
			</div>
			<span className="text-right tabular-nums text-dim">{value}</span>
		</>
	);
}

/**
 * Every limit an account is running against, one row each: the 5-hour window,
 * the 7-day window, and any per-model weekly cap. They free up at different
 * times, so which one is full changes what you do about it — a spent 5h clears
 * this afternoon, a spent Fable cap holds that model for days. Showing only the
 * fullest of them put the rest a hover away, which is no place for a fact
 * someone came to this page to read. Quiet ink keeps a page of accounts calm;
 * colour still means one thing, that this limit is running out.
 */
function UsageMeters({ windows }: { windows: LimitWindow[] }) {
	return (
		<>
			{liveLimits(windows).map((w, i) => (
				<Meter
					key={`${w.label}-${i}`}
					label={w.label}
					pct={w.utilization}
					value={`${Math.round(w.utilization)}%`}
					note={formatReset(w.resetsAt)}
					noteTitle={absoluteReset(w.resetsAt)}
				/>
			))}
		</>
	);
}

/**
 * Usage-credits (extra usage) spend for one account: what's been billed past
 * the subscription's included limits this month, against the account's monthly
 * credit cap. Values from the OAuth usage endpoint are cents. Hidden until
 * something has actually been spent: an account with extra usage merely
 * switched on drew a "$0.00" bar every month, which is a cap, not a cost.
 */
function ExtraUsageRow({
	extra,
}: {
	extra: { enabled: boolean; usedCredits: number; monthlyLimit: number } | null | undefined;
}) {
	if (!extra || extra.usedCredits <= 0) return null;
	const usd = (cents: number) =>
		`$${(cents / 100).toLocaleString([], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	const pct = extra.monthlyLimit > 0 ? (extra.usedCredits / extra.monthlyLimit) * 100 : null;
	return (
		<Meter
			label="Credits"
			labelTitle="Usage-credits: pay-as-you-go spend past the subscription limits, against this account's monthly credit cap (set at claude.ai)"
			pct={pct}
			value={usd(extra.usedCredits)}
			note={`${extra.monthlyLimit > 0 ? `${usd(extra.monthlyLimit)}/mo cap` : "no monthly cap"}${
				extra.enabled ? "" : " · off"
			}`}
		/>
	);
}

// ── Claude accounts ────────────────────────────────────────────────────────

/**
 * The one thing that needs attention, never stacked, so nothing collides. A
 * healthy account gets no pill: its meters already say it is fine, and nine
 * green "In rotation" pills down a page hid the two accounts that weren't.
 */
function ClaudeStatusPill({ a }: { a: ClaudeAccountInfo }) {
	if (a.usage?.error && a.usage.errorStatus === 401)
		return (
			<StatusPill tone="red" title={a.usage.error}>
				Token error
			</StatusPill>
		);
	if (a.usage?.error)
		return (
			<StatusPill tone="yellow" title={a.usage.error}>
				Usage unknown
			</StatusPill>
		);
	if (a.noUsageScope && !a.usage)
		return (
			<StatusPill tone="yellow" title="Add OAuth usage credentials to show dashboard usage.">
				Usage hidden
			</StatusPill>
		);
	if (a.exhaustedUntil)
		return (
			<StatusPill tone="red" title={`Sidelined until ${a.exhaustedUntil}`}>
				Limit hit
			</StatusPill>
		);
	if (a.usable) return null;
	return <StatusPill tone="yellow">Near limit</StatusPill>;
}

export function ClaudeAccountsSection() {
	const [accounts, setAccounts] = useState<ClaudeAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const addNameRef = useRef<HTMLInputElement>(null);
	const [signIn, setSignIn] = useState<ClaudeAccountInfo | null>(null);
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
			`~/.claude/accounts/${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/credentials.json`;
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
			<SettingsGroupLabel
				actions={
					<>
						<Button
							size="sm"
							icon={<IconHistory size={16} className={refreshing ? "animate-spin" : ""} />}
							onClick={() => load(true)}
							disabled={refreshing}
						>
							{refreshing ? "Checking…" : "Refresh usage"}
						</Button>
						<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
							Add account
						</Button>
					</>
				}
			>
				Claude accounts
			</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			<Modal.Root open={showAdd} onOpenChange={setShowAdd}>
				{/* The form is a child so the portal remounts it on every open,
				    which clears the pasted token rather than leaving it in state
				    after a dismissal. */}
				<Modal.Content initialFocus={addNameRef}>
					<AddClaudeAccountForm
						nameRef={addNameRef}
						onAdded={() => {
							setShowAdd(false);
							load();
						}}
					/>
				</Modal.Content>
			</Modal.Root>

			<SettingCard>
				{!accounts ? (
					<LoadingState placement="row">Loading accounts…</LoadingState>
				) : accounts.length === 0 ? (
					<EmptyState placement="row">
						No accounts yet, so runs use the VPS's own Claude login. Add Max-account tokens
						(<code>claude setup-token</code>) and runs pick the least-used one, rotating when
						one hits its limit.
					</EmptyState>
				) : (
					accounts.map((a) => (
						<React.Fragment key={a.id}>
						<SettingRow className="items-start">
							<Avatar name={a.name} className="bg-[#d97757]" />
							<SettingRowText>
								<div className="flex items-center gap-2 min-w-0">
									<SettingRowTitle className="truncate">{a.name}</SettingRowTitle>
									<ClaudeStatusPill a={a} />
								</div>
								{/* One line that identifies the account. The masked token only
								    earns its place when there is no email to name it by; it
								    stays in the tooltip either way. It takes the meters' size
								    rather than the settings row's default: at 13px against a
								    14px name the two read as one block, and an address nobody
								    needs to read was holding the same weight as the name you
								    scan the page by. */}
								<SettingRowDescription
									className="truncate text-meta"
									title={[a.email, a.plan?.replace("default_claude_", ""), a.tokenMasked]
										.filter(Boolean)
										.join(" · ")}
								>
									{a.email || a.tokenMasked}
									{a.plan ? ` · ${a.plan.replace("default_claude_", "")}` : ""}
								</SettingRowDescription>
								{a.noUsageScope && !a.usage ? (
									<div className="mt-1.5 text-meta text-faint">
										Usage not visible: setup-tokens cannot read the usage endpoint. Use
										“Sign in with Claude” in this account's menu to connect usage.
									</div>
								) : (
									<>
										<MeterGroup>
											<UsageMeters windows={claudeLimits(a.usage)} />
											<ExtraUsageRow extra={a.usage?.extraUsage} />
										</MeterGroup>
										{a.usage?.source === "meridian" && (
											<div className="mt-1.5 text-meta text-faint">
												Observed via the Meridian bridge (rate-limit events from live
												runs). The token can’t read the usage endpoint directly.
											</div>
										)}
										{a.usage?.error && (
											<div className="mt-1.5 text-meta text-red">{a.usage.error}</div>
										)}
									</>
								)}
							</SettingRowText>
							<SettingRowControl className="flex items-center gap-1.5">
								<OwnerSelect
									value={a.owner || ""}
									onChange={(owner) => handleSetOwner(a, owner)}
									label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal sub. Their runs use it first, everyone else never does.`
											: "Shared pool account, used by everyone and by automations."
									}
								/>
								<Menu.Root>
									<Menu.Trigger
										className={rowMenuTriggerClasses}
										aria-label={`Manage ${a.name}`}
									>
										<IconDotsHorizontal size={18} />
									</Menu.Trigger>
									<Menu.Popup align="end" sideOffset={4}>
										<Menu.Item onClick={() => setSignIn(a)}>
											<IconPlug size={16} className="text-faint" />
											Sign in with Claude (usage)…
										</Menu.Item>
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
							</SettingRowControl>
						</SettingRow>
						{signIn?.id === a.id && (
							<ClaudeSignInForm
								account={a}
								onClose={() => setSignIn(null)}
								onDone={() => {
									setSignIn(null);
									load();
								}}
							/>
						)}
						</React.Fragment>
					))
				)}
			</SettingCard>
			<SettingsHint>
				The usage pool for Claude runs. Each run picks the least-used account, and a
				personal one is used first by its owner and never by anyone else. For usage
				bars, sign in with Claude from an account's menu.
			</SettingsHint>
		</>
	);
}

// ── Codex accounts ─────────────────────────────────────────────────────────

function CodexStatusPill({ account }: { account: CodexAccountInfo }) {
	if (account.exhaustedUntil)
		return (
			<StatusPill tone="red" title={`Sidelined until ${account.exhaustedUntil}`}>
				Limit hit
			</StatusPill>
		);
	if (account.usage?.error)
		return (
			<StatusPill tone="yellow" title={account.usage.error}>
				Usage unknown
			</StatusPill>
		);
	return null;
}

function CodexUsageMeters({ account }: { account: CodexAccountInfo }) {
	if (account.kind === "api_key")
		return (
			<div className="mt-1.5 text-meta text-faint">
				Platform usage is billed at the organization level, not per API key.
			</div>
		);
	if (!account.usage)
		return <div className="mt-1.5 text-meta text-faint">Checking usage…</div>;
	if (account.usage.error)
		return <div className="mt-1.5 text-meta text-red">{account.usage.error}</div>;

	const bucketName = (bucket: CodexUsageBucket) =>
		bucket.label || (bucket.id === "codex" ? "Codex" : bucket.id);
	const windowLabel = (minutes: number | null) => {
		if (!minutes) return "Usage";
		if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
		if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
		if (minutes % 60 === 0) return `${minutes / 60}h`;
		return `${minutes}m`;
	};
	// A bucket the account names is a per-model budget (GPT-5.3-Codex-Spark)
	// rather than the plan's own window, so it is listed after the plan's and
	// carries the model's name.
	const multipleBuckets = account.usage.buckets.length > 1;
	const windows: LimitWindow[] = account.usage.buckets.flatMap((bucket) =>
		[bucket.primary, bucket.secondary].flatMap((window) => {
			if (!window) return [];
			const duration = windowLabel(window.windowDurationMins);
			return [
				{
					label: multipleBuckets ? `${bucketName(bucket)} ${duration}` : duration,
					utilization: window.utilization,
					resetsAt: window.resetsAt,
					scoped: !!bucket.label,
				},
			];
		}),
	);
	return (
		<>
			{windows.length > 0 && (
				<MeterGroup>
					<UsageMeters windows={windows} />
				</MeterGroup>
			)}
			{account.usage.resetCreditsAvailable !== null &&
				account.usage.resetCreditsAvailable > 0 && (
					<div className="mt-1.5 text-meta text-faint">
						{account.usage.resetCreditsAvailable} rate-limit reset
						{account.usage.resetCreditsAvailable === 1 ? "" : "s"} available
					</div>
				)}
		</>
	);
}

export function CodexAccountsSection() {
	const [accounts, setAccounts] = useState<CodexAccountInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const addNameRef = useRef<HTMLInputElement>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (forceUsage = false) => {
		if (forceUsage) setRefreshing(true);
		try {
			const res = forceUsage
				? await fetch(`${BASE_PATH}/api/codex-accounts/refresh`, { method: "POST" })
				: await fetch(`${BASE_PATH}/api/codex-accounts`);
			if (res.ok) setAccounts((await res.json()).accounts);
		} catch {}
		setRefreshing(false);
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
			<SettingsGroupLabel
				actions={
					<>
						<Button
							size="sm"
							icon={<IconHistory size={16} className={refreshing ? "animate-spin" : ""} />}
							onClick={() => load(true)}
							disabled={refreshing}
						>
							{refreshing ? "Checking…" : "Refresh usage"}
						</Button>
						<Button size="sm" icon={<IconPlus size={16} />} onClick={() => setShowAdd(true)}>
							Add account
						</Button>
					</>
				}
			>
				Codex accounts
			</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			<Modal.Root open={showAdd} onOpenChange={setShowAdd}>
				{/* Same remount contract as the Claude dialog. It also drives the
				    cleanup of a half-finished sign-in, which now hangs off the
				    form's unmount so Escape and the backdrop release it too. */}
				<Modal.Content initialFocus={addNameRef}>
					<AddCodexAccountForm
						nameRef={addNameRef}
						onAdded={() => {
							setShowAdd(false);
							load();
						}}
					/>
				</Modal.Content>
			</Modal.Root>

			<SettingCard>
				{!accounts ? (
					<LoadingState placement="row">Loading accounts…</LoadingState>
				) : accounts.length === 0 ? (
					<EmptyState placement="row">
						No accounts yet, so Codex runs use the VPS's own <code>codex login</code> (~/.codex).
						Add an OpenAI API key, or a CODEX_HOME directory holding a ChatGPT-plan{" "}
						<code>auth.json</code>, and runs rotate across the pool.
					</EmptyState>
				) : (
					accounts.map((a) => (
						<SettingRow key={a.id} className="items-start">
							<Avatar name={a.name} className="bg-[#10a37f]" />
							<SettingRowText>
								<div className="flex items-center gap-2 min-w-0">
									<SettingRowTitle className="truncate">{a.name}</SettingRowTitle>
									<CodexStatusPill account={a} />
								</div>
								{/* A ChatGPT login is named by its plan; the CODEX_HOME path it
								    lives at is the longest string on the row and identifies
								    nothing the account name doesn't, so it moves to the tooltip.
								    An API key has no plan, so its masked key stays visible. */}
								<SettingRowDescription className="truncate text-meta" title={a.valueMasked}>
									{a.kind === "api_key" ? "API key" : "ChatGPT login"}
									{a.usage?.buckets.find((bucket) => bucket.plan)?.plan
										? ` · ${a.usage.buckets.find((bucket) => bucket.plan)!.plan}`
										: ""}
									{a.kind === "api_key" ? ` · ${a.valueMasked}` : ""}
								</SettingRowDescription>
								<CodexUsageMeters account={a} />
							</SettingRowText>
							<SettingRowControl className="flex items-center gap-1.5">
								<OwnerSelect
									value={a.owner || ""}
									onChange={(owner) => handleSetOwner(a, owner)}
									label={`Owner of ${a.name}`}
									title={
										a.owner
											? `${a.owner}'s personal subscription. Their runs use it first, everyone else never does.`
											: "Shared pool account, used by everyone and by automations."
									}
								/>
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
							</SettingRowControl>
						</SettingRow>
					))
				)}
			</SettingCard>
			<SettingsHint>
				The pool for GPT and Codex runs. Runs rotate to the next account at the usage
				limit, and a personal one is used first by its owner and never by anyone else.
				Automations only use the shared pool.
			</SettingsHint>
		</>
	);
}

// ── Add forms ──────────────────────────────────────────────────────────────

function AddClaudeAccountForm({
	nameRef,
	onAdded,
}: {
	nameRef: RefObject<HTMLInputElement | null>;
	onAdded: () => void;
}) {
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [owner, setOwner] = useState("");
	const [credentialsPath, setCredentialsPath] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = Boolean(name.trim() && token.trim());

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
		<>
			<Modal.Header
				title="Add Claude account"
				description={
					<>
						On any machine, log into the Max account with <code>claude</code>, run{" "}
						<code>claude setup-token</code>, and paste the one-year token. It is stored on
						this server (0600) and only ever shown masked.
					</>
				}
			/>
			{/* Two zones: the credential itself, then the optional routing and
			    usage wiring. These were four fields on one horizontal row, which
			    left a path like ~/.claude/accounts/team/credentials.json in a
			    quarter-width box. */}
			<form
				className="flex flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					if (ready && !saving) void handleAdd();
				}}
			>
				<div className="flex flex-col gap-3">
					<Field label="Name">
						<Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="team" autoCapitalize="none" spellCheck={false} />
					</Field>
					<Field label="Token">
						<Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" />
					</Field>
				</div>
				<div className="flex flex-col gap-3">
					<Field label="Owner" title="Personal sub: this person's runs use the account first, with the shared pool as backup. Shared pool: used by everyone and by automations.">
						<OwnerSelect value={owner} onChange={setOwner} label="Owner" />
					</Field>
					<Field label="Usage credentials path">
						<Input value={credentialsPath} onChange={(e) => setCredentialsPath(e.target.value)} placeholder="Usage not tracked" autoCapitalize="none" spellCheck={false} />
					</Field>
					<p className="m-0 text-meta leading-relaxed text-faint">
						To show usage afterwards, use “Sign in with Claude” from the account's menu.
					</p>
				</div>

				{error && <InlineAlert>{error}</InlineAlert>}

				<Modal.Footer>
					<Modal.Close render={<Button variant="ghost" disabled={saving}>Cancel</Button>} />
					<Button variant="primary" type="submit" disabled={saving || !ready}>
						{saving ? "Validating…" : "Add account"}
					</Button>
				</Modal.Footer>
			</form>
		</>
	);
}

/**
 * "Sign in with Claude" — PKCE OAuth that attaches auto-refreshing usage
 * credentials to an existing pool account. The server hands us an authorize
 * URL; the user signs in on any device and pastes back the code Anthropic
 * displays (`…#…`), which the server exchanges and stores.
 *
 * Renders as an expansion directly beneath the triggering account row inside
 * the SettingCard (CardList draws the divider) — row-triggered content must
 * uncollapse in place, never teleport to the top of the section.
 */
function ClaudeSignInForm({
	account,
	onClose,
	onDone,
}: {
	account: ClaudeAccountInfo;
	onClose: () => void;
	onDone: () => void;
}) {
	const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/claude-accounts/oauth-login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accountId: account.id }),
				});
				const body = await res.json();
				if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
				if (!cancelled) setLogin(body);
			} catch (e: any) {
				if (!cancelled) setError(e.message);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [account.id]);

	function handleClose() {
		if (login) {
			fetch(`${BASE_PATH}/api/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`, {
				method: "DELETE",
			}).catch(() => {});
		}
		onClose();
	}

	async function handleConnect() {
		if (!login) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/claude-accounts/oauth-login/${encodeURIComponent(login.id)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Usage tracking connected for ${account.name}`);
			onDone();
		} catch (e: any) {
			setError(e.message);
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-3.5 bg-panel px-5 py-3.5">
			<SettingRowDescription>
				Connect usage tracking with its own auto-refreshing Claude login (runs keep using the
				setup-token). Open the link, sign in as{" "}
				{account.email ? <b>{account.email}</b> : "the Claude account behind this token"}, then
				paste the code Anthropic shows you.
			</SettingRowDescription>

			{login ? (
				<div className="flex items-end gap-3.5 phone:flex-col phone:items-stretch">
					<a className="shrink-0" href={login.url} target="_blank" rel="noreferrer">
						<Button icon={<IconPlug size={16} />}>Open Claude sign-in</Button>
					</a>
					<Field className="flex-1" label="Code">
						<Input
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="Paste the code from the sign-in page (…#…)"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
				</div>
			) : !error ? (
				<LoadingState placement="row">Preparing sign-in…</LoadingState>
			) : null}

			{error && <InlineAlert>{error}</InlineAlert>}

			<div className="flex justify-end gap-2.5">
				<Button variant="soft" onClick={handleClose} disabled={busy}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={handleConnect}
					disabled={busy || !login || !code.trim()}
				>
					{busy ? "Connecting…" : "Connect usage"}
				</Button>
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

/** How a Codex account is added: a ChatGPT sign-in, an existing CODEX_HOME
 *  directory, or a plain API key. */
const KIND_ITEMS = [
	{ value: "device", label: "ChatGPT sign-in · device code" },
	{ value: "oauth", label: "ChatGPT sign-in · link and paste" },
	{ value: "home", label: "ChatGPT login · existing CODEX_HOME directory" },
	{ value: "api_key", label: "OpenAI API key" },
];

function AddCodexAccountForm({
	nameRef,
	onAdded,
}: {
	nameRef: RefObject<HTMLInputElement | null>;
	onAdded: () => void;
}) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"device" | "oauth" | "api_key" | "home">("device");
	const [value, setValue] = useState("");
	const [owner, setOwner] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
	// Paste-link OAuth flow (kind "oauth") — the codex analog of the Claude
	// sign-in: open the URL anywhere, paste back the localhost redirect.
	const [oauth, setOauth] = useState<{ id: string; url: string } | null>(null);
	const [oauthCode, setOauthCode] = useState("");

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
				if (next.state === "done") {
					pending.current.done = true;
					onAdded();
				}
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

	// Abandoning a half-finished sign-in has to release it server-side, and the
	// dialog can now be dismissed by Escape or the backdrop as well as by
	// Cancel. So the cleanup hangs off unmount, which every one of those paths
	// goes through, rather than off the Cancel handler alone the way it used to
	// (dismissing any other way leaked the pending login).
	const pending = useRef<{ login?: string; oauth?: string; done: boolean }>({ done: false });
	pending.current.login =
		login && (login.state === "starting" || login.state === "awaiting_code") ? login.id : undefined;
	pending.current.oauth = oauth?.id;
	useEffect(
		() => () => {
			const { login: loginId, oauth: oauthId, done } = pending.current;
			if (done) return;
			if (loginId)
				fetch(`${BASE_PATH}/api/codex-accounts/device-login/${encodeURIComponent(loginId)}`, {
					method: "DELETE",
				}).catch(() => {});
			if (oauthId)
				fetch(`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauthId)}`, {
					method: "DELETE",
				}).catch(() => {});
		},
		[],
	);

	async function handleStartOauth() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/codex-accounts/oauth-login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					...(owner.trim() ? { owner: owner.trim() } : {}),
				}),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setOauth(body);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	async function handleCompleteOauth() {
		if (!oauth) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(
				`${BASE_PATH}/api/codex-accounts/oauth-login/${encodeURIComponent(oauth.id)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code: oauthCode }),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Codex account "${name.trim()}" added to the pool`);
			pending.current.done = true;
			onAdded();
			return;
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
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
			pending.current.done = true;
			onAdded();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	const loginPending = login && (login.state === "starting" || login.state === "awaiting_code");

	return (
		<>
			<Modal.Header
				title="Add Codex account"
				description={kind === "device" ? (
					<>
						Sign in with ChatGPT from here, with no VPS access needed. You'll get a link and a
						one-time code to enter on any device. (Device-code login must be enabled in the
						ChatGPT workspace's security settings.)
					</>
				) : kind === "oauth" ? (
					<>
						Sign in with ChatGPT on any device. Works even where device-code login is
						disabled. After signing in you'll land on a <code>localhost</code> page that
						fails to load; copy that page's full address and paste it back here.
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
			/>

			<form
				className="flex flex-col gap-5"
				onSubmit={(event) => {
					event.preventDefault();
					if (saving) return;
					if (kind === "device") {
						if (name.trim() && !loginPending && login?.state !== "done") void handleStartDeviceLogin();
					} else if (kind === "oauth") {
						if (oauth) {
							if (oauthCode.trim()) void handleCompleteOauth();
						} else if (name.trim()) void handleStartOauth();
					} else if (name.trim() && value.trim()) void handleAdd();
				}}
			>
			<div className="flex flex-col gap-3">
				<Field label="Name">
					<Input
						ref={nameRef}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="team"
						disabled={!!login || !!oauth}
						autoCapitalize="none"
						spellCheck={false}
					/>
				</Field>
				<Field label="Kind">
					<Select.Root
						items={KIND_ITEMS}
						value={kind}
						disabled={!!login || !!oauth}
						onValueChange={(next) => setKind(next as "device" | "oauth" | "api_key" | "home")}
					>
						<Select.Trigger aria-label="Kind" />
						<Select.Popup>
							{KIND_ITEMS.map((k) => (
								<Select.Item key={k.value} value={k.value}>
									{k.label}
								</Select.Item>
							))}
						</Select.Popup>
					</Select.Root>
				</Field>
				{kind !== "device" && kind !== "oauth" && (
					<Field label={kind === "api_key" ? "API key" : "CODEX_HOME path"}>
						<Input
							type={kind === "api_key" ? "password" : "text"}
							autoComplete={kind === "api_key" ? "off" : undefined}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder={kind === "api_key" ? "sk-…" : "~/.codex-accounts/team"}
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
				)}
				<Field label="Owner" title="Personal sub: this person's runs use the account first, with the shared pool as backup. Shared pool: used by everyone and by automations.">
					<OwnerSelect
						value={owner}
						onChange={setOwner}
						label="Owner"
						disabled={!!login || !!oauth}
					/>
				</Field>
			</div>

			{login && (
				// A well inside the dialog, so the live sign-in stands apart
				// from the fields without another border.
				<div className="rounded-md bg-surface px-4 py-3 text-supporting">
					{login.state === "starting" && <div className="text-dim">Starting sign-in…</div>}
					{login.state === "awaiting_code" && (
						<>
							<div>
								1. Open{" "}
								<a
									href={login.url}
									target="_blank"
									rel="noreferrer"
									className="text-link underline"
								>
									{login.url}
								</a>{" "}
								and sign in to the ChatGPT account.
							</div>
							<div className="mt-1.5">2. Enter this one-time code (expires in 15 min):</div>
							{login.code && (
								<div className="my-2">
									<DeviceCode code={login.code} className="text-section-title" />
								</div>
							)}
							<div className="text-dim">
								Waiting for the sign-in to complete… this panel updates by itself.
							</div>
						</>
					)}
					{login.state === "done" && (
						<div>Signed in. Account "{login.name}" added to the pool.</div>
					)}
					{login.state === "error" && (
						<InlineAlert
							className="whitespace-pre-wrap"
							onRetry={() => setLogin(null)}
							retryLabel="Try again"
						>
							{login.error || "Sign-in failed."}
						</InlineAlert>
					)}
				</div>
			)}

			{oauth && (
				<div className="rounded-md bg-surface px-4 py-3 text-supporting">
					<div>
						1. Open{" "}
						<a
							href={oauth.url}
							target="_blank"
							rel="noreferrer"
							className="text-link underline"
						>
							the ChatGPT sign-in
						</a>{" "}
						and sign in to the account.
					</div>
					<div className="mt-1.5">
						2. The browser lands on a <code>localhost</code> page that can't load. Copy its
						full address (starts with <code>http://localhost:1455/…</code>) and paste it:
					</div>
					<Input
						className="mt-2"
						value={oauthCode}
						onChange={(e) => setOauthCode(e.target.value)}
						placeholder="http://localhost:1455/auth/callback?code=…"
						aria-label="Pasted sign-in redirect URL"
						autoCapitalize="none"
						spellCheck={false}
					/>
				</div>
			)}

			{error && <InlineAlert>{error}</InlineAlert>}

			<Modal.Footer>
				<Modal.Close
					render={
						<Button variant="ghost" disabled={saving}>
							{loginPending || oauth ? "Cancel sign-in" : "Cancel"}
						</Button>
					}
				/>
				{kind === "device" ? (
					<Button
						variant="primary"
						type="submit"
						disabled={saving || !name.trim() || !!loginPending || login?.state === "done"}
					>
						{saving ? "Starting…" : loginPending ? "Waiting for sign-in…" : "Start sign-in"}
					</Button>
				) : kind === "oauth" ? (
					oauth ? (
						<Button variant="primary" type="submit" disabled={saving || !oauthCode.trim()}>
							{saving ? "Connecting…" : "Connect"}
						</Button>
					) : (
						<Button variant="primary" type="submit" disabled={saving || !name.trim()}>
							{saving ? "Starting…" : "Start sign-in"}
						</Button>
					)
				) : (
					<Button
						variant="primary"
						type="submit"
						disabled={saving || !name.trim() || !value.trim()}
					>
						{saving ? "Adding…" : "Add account"}
					</Button>
				)}
			</Modal.Footer>
			</form>
		</>
	);
}
