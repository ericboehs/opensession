import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState } from "react";
import {
	getNotifSettings,
	setNotifSettings,
	onNotifSettingsChanged,
	ensureNotificationPermission,
	playSound,
	SOUND_OPTIONS,
	WHEN_OPTIONS,
	type NotifSettings,
} from "../lib/notify";
import {
	getThemePref,
	setThemePref,
	onThemeChanged,
	type ThemePref,
} from "../lib/theme";
import {
	getWsTimePref,
	setWsTimePref,
	onWsTimeChanged,
	type WsTimePref,
} from "../lib/workspace-time";
import {
	getTurnActivityPref,
	setTurnActivityPref,
	onTurnActivityChanged,
	type TurnActivityPref,
} from "../lib/turn-activity";
import {
	getSendKeyPref,
	setSendKeyPref,
	onSendKeyChanged,
	getBusySendPref,
	setBusySendPref,
	onBusySendChanged,
	MOD_ENTER_LABEL,
	MOD_ENTER_GLYPH,
	type BusySendPref,
	type SendKeyPref,
} from "../lib/send-key";
import {
	getPinNewSessions,
	setPinNewSessions,
	onPinNewSessionsChanged,
	getPinNewWorkspaces,
	setPinNewWorkspaces,
	onPinNewWorkspacesChanged,
} from "../lib/pins";
import { Connections } from "./Connections";
import { ModelsPanel } from "./Models";
import { ModelProvidersPanel } from "./ModelProviders";
import {
	fetchMonitorConfig,
	updateMonitorConfig,
	fetchAutoArchiveConfig,
	updateAutoArchiveConfig,
	fetchAudit,
	fetchWarmTemplates,
	updateWarmTemplate,
	refreshWarmTemplateNow,
	type MonitorConfig,
	type AutoArchiveConfig,
	type WarmTemplateEntry,
} from "../lib/api";
import { getPushState, enablePush, disablePush, type PushState } from "../lib/push";
import { getCurrentUser } from "./UserPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { BottomSheet } from "../ui/sheet";
import { cn } from "../ui/cn";
import { IconChevronLeft, IconChevronRight, IconX } from "./icons";
import { Tooltip } from "../ui/tooltip";
import { AGENT_NAME, PRODUCT_NAME } from "../lib/brand";

// The full-window Settings surface: a left sub-nav + a scrolling body, reached
// from the "Settings" item in the Michael menu. Designed to grow — each area is
// just another entry in SECTIONS and a matching panel below. The "Tools" group
// holds the app's tool surfaces (Automations, Goals, …) — those render at their
// own routes (<base>/automations, …) with this surface as chrome, so the
// section is controlled by the router, not local state. The "Personal" group
// holds per-browser preferences (notifications, theme); the "Workspace" group holds
// shared setup that configures how every session runs (default model, connections).

/** Tool surfaces hosted inside Settings — App renders their panel as children. */
export type ToolSectionKey =
	| "automations"
	| "goals"
	| "actions"
	| "security"
	| "notes";

export type SettingsSectionKey =
	| "notifications"
	| "monitor"
	| "autoArchive"
	| "composer"
	| "appearance"
	| "workspace"
	| "model"
	| "modelProviders"
	| "connections"
	| "warmPreviews"
	| "audit"
	| ToolSectionKey;

const TOOL_SECTIONS = new Set<SettingsSectionKey>([
	"automations",
	"goals",
	"actions",
	"security",
	"notes",
]);

const SECTIONS: {
	key: SettingsSectionKey;
	label: string;
	group: string;
	icon: React.ReactNode;
}[] = [
	{
		key: "automations",
		label: "Automations",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "goals",
		label: "Goals",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="6" />
				<circle cx="8" cy="8" r="3" />
				<circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		key: "actions",
		label: "Actions",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-.5-5.5z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "security",
		label: "Security",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 1.8l4.6 1.7v3.8c0 3-1.9 5.2-4.6 6.5-2.7-1.3-4.6-3.5-4.6-6.5V3.5L8 1.8z"
					strokeLinejoin="round"
				/>
				<path d="M6.1 8l1.3 1.3 2.5-2.6" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		key: "notes",
		label: "Notes",
		group: "Tools",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M3 2.5h7a2 2 0 0 1 2 2v9l-3-1.8-3 1.8-3-1.8V2.5z"
					strokeLinejoin="round"
					transform="translate(0.5,0)"
				/>
			</svg>
		),
	},
	{
		key: "notifications",
		label: "Notifications",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 2.2a3.4 3.4 0 0 0-3.4 3.4c0 2.9-1.1 3.9-1.1 3.9h9A5.4 5.4 0 0 1 11.4 5.6 3.4 3.4 0 0 0 8 2.2z"
					strokeLinejoin="round"
				/>
				<path d="M6.7 12a1.4 1.4 0 0 0 2.6 0" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "monitor",
		label: "Monitor",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="6" />
				<path d="M8 4.5V8l2.3 1.6" strokeLinecap="round" strokeLinejoin="round" />
				<circle cx="12.6" cy="3.4" r="1.6" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		key: "autoArchive",
		label: "Auto-archive",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
				<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
				<path d="M6.5 8.5h3" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "composer",
		label: "Composer",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="1.75" y="4.25" width="12.5" height="7.5" rx="1.2" />
				<path
					d="M4 6.8h.01M6.7 6.8h.01M9.4 6.8h.01M12.1 6.8h.01M5 9.5h6"
					strokeLinecap="round"
				/>
			</svg>
		),
	},
	{
		key: "appearance",
		label: "Appearance",
		group: "Personal",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		key: "workspace",
		label: "General",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="5.5" r="2.5" />
				<path d="M3.5 13.5c.6-2.4 2.4-3.6 4.5-3.6s3.9 1.2 4.5 3.6" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "model",
		label: "Models",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 2.3l1.2 3.3 3.3 1.2-3.3 1.2L8 11.3 6.8 8 3.5 6.8l3.3-1.2L8 2.3z"
					strokeLinejoin="round"
				/>
				<path
					d="M12.4 10.4l.4 1.3 1.3.4-1.3.4-.4 1.3-.4-1.3-1.3-.4 1.3-.4.4-1.3z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "modelProviders",
		label: "Model providers",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<rect x="2.25" y="2.25" width="5" height="5" rx="1" />
				<rect x="8.75" y="8.75" width="5" height="5" rx="1" />
				<circle cx="11.25" cy="4.75" r="2.5" />
				<path d="M4.75 9.5v1.75a1 1 0 0 0 1 1h1.75" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "connections",
		label: "Connections",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="4.5" cy="8" r="2" />
				<circle cx="11.5" cy="4" r="2" />
				<circle cx="11.5" cy="12" r="2" />
				<path d="M6.3 7.1l3.4-2.2M6.3 8.9l3.4 2.2" strokeLinecap="round" />
			</svg>
		),
	},
	{
		key: "warmPreviews",
		label: "Warm previews",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 1.8c.4 2.2 3.7 3.4 3.7 6.7a3.7 3.7 0 0 1-7.4 0c0-1.4.6-2.4 1.4-3.4.2 1 .7 1.6 1.4 2 0-1.9.2-3.9.9-5.3z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		key: "audit",
		label: "Audit log",
		group: "Workspace",
		icon: (
			<svg
				width="20"
				height="20"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" strokeLinejoin="round" />
				<path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" strokeLinecap="round" />
			</svg>
		),
	},
];

/** The active section's panel — shared by the desktop split and the phone
 * sheet's detail page. Tool panels come in via children (App owns them). */
function SectionPanel({
	section,
	children,
}: {
	section: SettingsSectionKey;
	children?: React.ReactNode;
}) {
	return (
		<>
			{TOOL_SECTIONS.has(section) && children}
			{section === "notifications" && <NotificationsPanel />}
			{section === "monitor" && <MonitorPanel />}
			{section === "autoArchive" && <AutoArchivePanel />}
			{section === "composer" && <ComposerPanel />}
			{section === "appearance" && <AppearancePanel />}
			{section === "workspace" && <WorkspacePanel />}
			{section === "audit" && <AuditPanel />}
			{section === "model" && <ModelsPanel />}
			{section === "modelProviders" && <ModelProvidersPanel />}
			{section === "connections" && <Connections />}
			{section === "warmPreviews" && <WarmPreviewsPanel />}
		</>
	);
}

export function Settings({
	onBack,
	section,
	onSelect,
	onShowRoot,
	children,
}: {
	onBack: () => void;
	/** Active section, derived from the route (tools have their own URLs).
	 * Undefined = no explicit section: desktop defaults to Notifications, the
	 * phone sheet shows its root list of sections. */
	section?: SettingsSectionKey;
	/** Navigate to a section — App maps tool keys to their own routes. */
	onSelect: (key: SettingsSectionKey) => void;
	/** Phone sheet's back-to-root (navigate to sectionless /settings). */
	onShowRoot?: () => void;
	/** The active tool's panel (App owns the tool components and their props). */
	children?: React.ReactNode;
}) {
	const isPhone = useIsPhone();

	// Esc returns to the app (desktop only — the phone sheet handles Esc itself
	// so the exit animation plays).
	useEffect(() => {
		if (isPhone) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onBack();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onBack, isPhone]);

	// Group the nav entries under their group label (order preserved).
	const groups: { group: string; items: typeof SECTIONS }[] = [];
	for (const s of SECTIONS) {
		let g = groups.find((x) => x.group === s.group);
		if (!g) groups.push((g = { group: s.group, items: [] }));
		g.items.push(s);
	}

	if (isPhone)
		return (
			<MobileSettings
				groups={groups}
				section={section}
				onSelect={onSelect}
				onShowRoot={onShowRoot}
				onBack={onBack}
			>
				{children}
			</MobileSettings>
		);

	const active = section ?? "notifications";

	return (
		<div className="settings-page">
			<aside className="settings-sidenav">
				<button className="settings-back" onClick={onBack}>
					<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
						<path
							d="M10 3.5L5.5 8l4.5 4.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
					Back to app
				</button>
				{groups.map((g) => (
					<div className="settings-sidenav-group" key={g.group}>
						<div className="settings-sidenav-label">{g.group}</div>
						{g.items.map((s) => (
							<button
								key={s.key}
								className={`settings-sidenav-item ${
									active === s.key ? "active" : ""
								}`}
								onClick={() => onSelect(s.key)}
							>
								<span className="settings-sidenav-icon">{s.icon}</span>
								{s.label}
							</button>
						))}
					</div>
				))}
			</aside>

			{/* Tool sections fill the whole content area edge-to-edge (they carry
			    their own layout/scrolling); settings panels keep the centered,
			    padded reading column. */}
			<div
				className={`settings-content${
					TOOL_SECTIONS.has(active) ? " settings-content-tool" : ""
				}`}
			>
				<SectionPanel section={active}>{children}</SectionPanel>
			</div>
		</div>
	);
}

/**
 * Phone Settings: a bottom sheet sliding up over the root page, with iOS-style
 * paging inside — the root page lists the sections as grouped tappable rows,
 * and picking one slides its panel in from the right (Back slides it out).
 * Which page shows is route-driven: a section in the URL = detail page.
 */
function MobileSettings({
	groups,
	section,
	onSelect,
	onShowRoot,
	onBack,
	children,
}: {
	groups: { group: string; items: typeof SECTIONS }[];
	section?: SettingsSectionKey;
	onSelect: (key: SettingsSectionKey) => void;
	onShowRoot?: () => void;
	onBack: () => void;
	children?: React.ReactNode;
}) {
	// Keep the last opened section mounted while popping back to the root, so
	// the detail page has content during its slide-out.
	const [lastSection, setLastSection] = useState<SettingsSectionKey | null>(
		section ?? null,
	);
	useEffect(() => {
		if (section) setLastSection(section);
	}, [section]);

	const detail = section ?? null;
	const shownSection = detail ?? lastSection;
	const shownLabel = SECTIONS.find((s) => s.key === shownSection)?.label;
	const pageEase = "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]";

	return (
		<BottomSheet onClose={onBack} label="Settings" className="settings-sheet h-[93dvh]">
			{(dismiss) => (
				<>
					<div className="relative flex h-11 shrink-0 items-center justify-center px-3">
						{detail && (
							<button
								className="absolute left-1 flex items-center gap-0.5 rounded-md border-none bg-transparent px-2 py-2 text-[15px] font-medium text-accent"
								onClick={() => onShowRoot?.()}
							>
								<IconChevronLeft size={22} />
								Settings
							</button>
						)}
						<span className="text-[16px] font-semibold text-fg">
							{detail ? shownLabel : "Settings"}
						</span>
						<button
							className="absolute right-3 flex h-8 w-8 items-center justify-center rounded-full border-none bg-active text-dim"
							onClick={dismiss}
							aria-label="Close settings"
						>
							<IconX size={22} />
						</button>
					</div>

					<div className="relative min-h-0 flex-1 overflow-hidden">
						{/* Root page: grouped section list. Parked slightly left while a
						    detail page covers it, iOS-style. */}
						<div
							className={cn(
								"absolute inset-0 overflow-y-auto px-4 pb-10",
								pageEase,
								detail && "-translate-x-1/3",
							)}
							aria-hidden={!!detail}
						>
							{groups.map((g) => (
								<div key={g.group}>
									<div className="mb-2 mt-5 px-1 text-[13px] font-semibold text-faint">
										{g.group}
									</div>
									<div className="overflow-hidden rounded-2xl border border-line bg-panel">
										{g.items.map((s) => (
											<button
												key={s.key}
												className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3 text-left last:border-b-0 active:bg-hover"
												onClick={() => onSelect(s.key)}
											>
												<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
													{s.icon}
												</span>
												<span className="min-w-0 flex-1 text-[15px] font-medium text-fg">
													{s.label}
												</span>
												<IconChevronRight size={20} className="shrink-0 text-faint" />
											</button>
										))}
									</div>
								</div>
							))}
						</div>

						{/* Detail page: the picked section's panel, slid in from the right. */}
						<div
							className={cn(
								"absolute inset-0 flex flex-col bg-surface",
								pageEase,
								detail ? "translate-x-0" : "translate-x-full",
							)}
							aria-hidden={!detail}
						>
							{shownSection && (
								<div
									className={`settings-content min-h-0 flex-1${
										TOOL_SECTIONS.has(shownSection)
											? " settings-content-tool"
											: ""
									}`}
								>
									<SectionPanel section={shownSection}>{children}</SectionPanel>
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</BottomSheet>
	);
}

// ── Reusable controls ──────────────────────────────────────────────────────

function SettingRow({
	title,
	desc,
	control,
}: {
	title: string;
	desc: React.ReactNode;
	control: React.ReactNode;
}) {
	return (
		<div className="setting-row">
			<div className="setting-row-text">
				<div className="setting-row-title">{title}</div>
				<div className="setting-row-desc">{desc}</div>
			</div>
			<div className="setting-row-control">{control}</div>
		</div>
	);
}

function Toggle({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		<button
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className={`ui-switch ${checked ? "on" : ""}`}
			onClick={() => onChange(!checked)}
		>
			<span className="ui-switch-knob" />
		</button>
	);
}

function Select<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
	label: string;
}) {
	return (
		<select
			className="ui-select"
			aria-label={label}
			value={value}
			onChange={(e) => onChange(e.target.value as T)}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

// ── Notifications ──────────────────────────────────────────────────────────

/** The device-level Web Push toggle inside Notifications. */
function PushRow() {
	const [state, setState] = useState<PushState | "loading">("loading");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		getPushState().then(setState);
	}, []);

	async function toggle(v: boolean) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			if (v) await enablePush(getCurrentUser());
			else await disablePush();
			setState(await getPushState());
		} catch (e: any) {
			setError(e.message);
			setState(await getPushState());
		}
		setBusy(false);
	}

	return (
		<SettingRow
			title="Push to this device"
			desc={
				error ||
				(state === "unsupported"
					? "Push needs the HTTPS origin (michael.taila5d766.ts.net). It isn't available on plain http."
					: state === "denied"
						? "Notifications are blocked for this site. Allow them in your browser to enable push."
						: "Buzz this device when a session needs your input, even with the app closed. It's per device, so enable it on your phone too.")
			}
			control={
				<Toggle
					label="Push to this device"
					checked={state === "on"}
					onChange={toggle}
				/>
			}
		/>
	);
}

function NotificationsPanel() {
	const [s, setS] = useState<NotifSettings>(getNotifSettings);
	useEffect(() => onNotifSettingsChanged(() => setS(getNotifSettings())), []);

	function patch(p: Partial<NotifSettings>) {
		setS(setNotifSettings(p));
	}

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Notifications</h1>

			<div className="settings-group-label">Alerts</div>
			<div className="setting-card">
				<PushRow />
				<SettingRow
					title="Desktop notifications"
					desc="Get a banner when one of your sessions needs input or finishes."
					control={
						<Toggle
							label="Desktop notifications"
							checked={s.desktop}
							onChange={(v) => {
								if (v) ensureNotificationPermission();
								patch({ desktop: v });
							}}
						/>
					}
				/>
				<SettingRow
					title="Completion sound"
					desc="What plays when a session needs input or finishes."
					control={
						<div className="setting-inline">
							<Select
								label="Completion sound"
								value={s.sound}
								options={SOUND_OPTIONS}
								onChange={(v) => patch({ sound: v })}
							/>
							<button
								className="ui-testbtn"
								onClick={() => playSound(s.sound)}
								disabled={s.sound === "none"}
								title="Play sound"
							>
								<svg width="20" height="20" viewBox="0 0 16 16" fill="none">
									<path
										d="M3 6v4h2.5L9 13V3L5.5 6H3z"
										stroke="currentColor"
										strokeWidth="1.3"
										strokeLinejoin="round"
									/>
									<path
										d="M11 6.2c.6.5.9 1.1.9 1.8s-.3 1.3-.9 1.8"
										stroke="currentColor"
										strokeWidth="1.3"
										strokeLinecap="round"
									/>
								</svg>
								Test
							</button>
						</div>
					}
				/>
				<SettingRow
					title="When to notify"
					desc="Alert always, only when this tab is in the background, or never."
					control={
						<Select
							label="When to notify"
							value={s.when}
							options={WHEN_OPTIONS}
							onChange={(v) => patch({ when: v })}
						/>
					}
				/>
			</div>

			<div className="settings-group-label">Events</div>
			<div className="setting-card">
				<SettingRow
					title="Needs input"
					desc="Alert when a session is blocked waiting for your answer."
					control={
						<Toggle
							label="Needs input alerts"
							checked={s.needsInput}
							onChange={(v) => patch({ needsInput: v })}
						/>
					}
				/>
				<SettingRow
					title="Run complete"
					desc="Alert when one of your sessions finishes working."
					control={
						<Toggle
							label="Run complete alerts"
							checked={s.done}
							onChange={(v) => patch({ done: v })}
						/>
					}
				/>
			</div>
		</div>
	);
}

// ── Appearance ─────────────────────────────────────────────────────────────

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

// A miniature app mockup used inside the theme swatches. `tone` picks the fixed
// light/dark palette (independent of the current theme) via CSS-var classes.
function ThemeMock({ tone }: { tone: "light" | "dark" }) {
	return (
		<div className={`theme-mock mk-${tone}`}>
			<div className="theme-mock-head">
				<div className="theme-mock-bar w1" />
				<div className="theme-mock-bar w2" />
			</div>
			<div className="theme-mock-card">
				<div className="theme-mock-row" />
				<div className="theme-mock-row" />
				<div className="theme-mock-row" />
			</div>
		</div>
	);
}

function ThemeCard({
	option,
	active,
	onClick,
}: {
	option: ThemePref;
	active: boolean;
	onClick: () => void;
}) {
	const label = THEME_OPTIONS.find((o) => o.value === option)?.label ?? option;
	return (
		<button
			className={`theme-card ${active ? "active" : ""}`}
			role="radio"
			aria-checked={active}
			onClick={onClick}
		>
			<div className="theme-swatch">
				{/* System = light base with the dark mock clipped over the right half. */}
				<ThemeMock tone={option === "dark" ? "dark" : "light"} />
				{option === "system" && (
					<div className="theme-swatch-split">
						<ThemeMock tone="dark" />
					</div>
				)}
			</div>
			<span className="theme-card-label">{label}</span>
		</button>
	);
}

/**
 * Autonomous session monitor — per-user, opt-in, default OFF. The server loop
 * (src/agents/loops/session-monitor.ts) only checks users who enabled it here.
 */
function MonitorPanel() {
	const user = getCurrentUser();
	const [cfg, setCfg] = useState<MonitorConfig | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetchMonitorConfig(user)
			.then(setCfg)
			.catch((e) => setError(e.message));
	}, [user]);

	function patch(p: Partial<MonitorConfig>) {
		if (!cfg) return;
		const optimistic = { ...cfg, ...p };
		setCfg(optimistic);
		updateMonitorConfig(user, p)
			.then(setCfg)
			.catch((e) => setError(e.message));
	}

	if (!cfg)
		return (
			<div className="settings-panel">
				<h1 className="settings-title">Monitor</h1>
				<div className="setting-row-desc">{error || "Loading…"}</div>
			</div>
		);

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Monitor</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				Michael keeps an eye on <b>{user}</b>'s sessions while you're away:
				you get a Slack DM when one is blocked on a question or looks
				stalled, and (optionally) obvious questions get answered for you.
				Off by default; this only ever touches your own sessions.
			</div>

			{error && (
				<div className="form-error" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			<div className="setting-card">
				<SettingRow
					title="Watch my sessions"
					desc="The master switch. Nothing below runs while this is off."
					control={
						<Toggle
							label="Watch my sessions"
							checked={cfg.enabled}
							onChange={(v) => patch({ enabled: v })}
						/>
					}
				/>
				<SettingRow
					title="Check every"
					desc="How often the monitor looks at your sessions."
					control={
						<Select
							label="Check interval"
							value={String(cfg.intervalMinutes)}
							options={[
								{ value: "5", label: "5 minutes" },
								{ value: "10", label: "10 minutes" },
								{ value: "15", label: "15 minutes" },
								{ value: "30", label: "30 minutes" },
							]}
							onChange={(v) => patch({ intervalMinutes: Number(v) })}
						/>
					}
				/>
				<SettingRow
					title="Slack DM"
					desc="DM you when a session needs input or has stalled."
					control={
						<Toggle
							label="Slack DM"
							checked={cfg.slackDm}
							onChange={(v) => patch({ slackDm: v })}
						/>
					}
				/>
				<SettingRow
					title="Answer obvious questions"
					desc="When a session pauses on a multiple-choice question whose answer is clearly implied by its own context, answer it and tell you what was picked and why. Conservative: consequential or preferential choices always wait for you."
					control={
						<Toggle
							label="Answer obvious questions"
							checked={cfg.autoAnswer}
							onChange={(v) => patch({ autoAnswer: v })}
						/>
					}
				/>
				<SettingRow
					title="Stalled after"
					desc="Flag a running session with no activity for this long."
					control={
						<Select
							label="Stalled after"
							value={String(cfg.stalledMinutes)}
							options={[
								{ value: "30", label: "30 minutes" },
								{ value: "60", label: "1 hour" },
								{ value: "120", label: "2 hours" },
								{ value: "240", label: "4 hours" },
							]}
							onChange={(v) => patch({ stalledMinutes: Number(v) })}
						/>
					}
				/>
			</div>
		</div>
	);
}

/**
 * Auto-archive sessions that look done — per user, opt-in by repo. Off
 * everywhere by default except "backstage" itself, since fast self-hosting
 * iteration there means constant manual tidy-up otherwise.
 */
function AutoArchivePanel() {
	const user = getCurrentUser();
	const [cfg, setCfg] = useState<AutoArchiveConfig | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetchAutoArchiveConfig(user)
			.then(setCfg)
			.catch((e) => setError(e.message));
	}, [user]);

	function patch(
		p: Partial<Pick<AutoArchiveConfig, "onMerge" | "repos" | "onChecksGreen">>,
	) {
		if (!cfg) return;
		const optimistic = { ...cfg, ...p };
		setCfg(optimistic);
		updateAutoArchiveConfig(user, p)
			.then((next) => setCfg({ ...next, availableRepos: cfg.availableRepos }))
			.catch((e) => setError(e.message));
	}

	function toggleRepo(repo: string, on: boolean) {
		if (!cfg) return;
		const repos = on
			? [...cfg.repos, repo]
			: cfg.repos.filter((r) => r !== repo);
		patch({ repos });
	}

	if (!cfg)
		return (
			<div className="settings-panel">
				<h1 className="settings-title">Auto-archive</h1>
				<div className="setting-row-desc">{error || "Loading…"}</div>
			</div>
		);

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Auto-archive</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				When a session looks done, Michael archives it for you — sorted under
				"Auto-archived" in <b>{user}</b>'s Archived list instead of sitting in
				My sessions. Merged PRs are archived everywhere by default; the
				pre-merge "checks green" trigger below is per-repo.
			</div>

			{error && (
				<div className="form-error" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			<div className="setting-card">
				<SettingRow
					title="Archive when its PR merges"
					desc="Once a session's pull request is merged, archive it. Applies to every repo. A merged PR is done."
					control={
						<Toggle
							label="Archive when its PR merges"
							checked={cfg.onMerge}
							onChange={(v) => patch({ onMerge: v })}
						/>
					}
				/>
				<SettingRow
					title="Archive once checks are green"
					desc="Also archive an open (unmerged) PR once every check passes, not just after merge. Good for repos that iterate fast and don't need the PR to stick around once it builds. Applies only to the repos below."
					control={
						<Toggle
							label="Archive once checks are green"
							checked={cfg.onChecksGreen}
							onChange={(v) => patch({ onChecksGreen: v })}
						/>
					}
				/>
			</div>

			<div
				className="setting-row-desc"
				style={{ marginTop: 18, marginBottom: 8 }}
			>
				Repos for the "checks green" trigger
			</div>
			<div className="setting-card">
				{cfg.availableRepos.map((repo) => (
					<SettingRow
						key={repo}
						title={repo}
						desc={
							repo === "backstage"
								? `Archive on green checks here too. ${PRODUCT_NAME} self-hosts, so sessions finish fast and pile up otherwise.`
								: `Archive open PRs in ${repo} once their checks pass.`
						}
						control={
							<Toggle
								label={`Auto-archive ${repo}`}
								checked={cfg.repos.includes(repo)}
								onChange={(v) => toggleRepo(repo, v)}
							/>
						}
					/>
				))}
			</div>
		</div>
	);
}

// ── Warm previews (per-repo prebuilt template worktrees) ────────────────────

const WARM_INTERVAL_OPTIONS: { value: string; label: string }[] = [
	{ value: "1", label: "Every hour" },
	{ value: "3", label: "Every 3 hours" },
	{ value: "6", label: "Every 6 hours" },
	{ value: "12", label: "Every 12 hours" },
	{ value: "24", label: "Daily" },
];

function warmAgo(iso?: string): string {
	if (!iso) return "never";
	const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function WarmPreviewsPanel() {
	const [repos, setRepos] = useState<WarmTemplateEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchWarmTemplates()
			.then((r) => alive && setRepos(r.repos))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, []);

	// A refresh boots a real dev server (minutes) — poll while one runs so the
	// status line flips to "Warm at <sha>" on its own.
	useEffect(() => {
		if (!repos?.some((e) => e.refreshing)) return;
		let alive = true;
		const t = setTimeout(() => {
			fetchWarmTemplates()
				.then((r) => alive && setRepos(r.repos))
				.catch(() => {});
		}, 5000);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [repos]);

	function apply(p: Promise<{ repos: WarmTemplateEntry[] }>) {
		p.then((r) => setRepos(r.repos)).catch((e) => setError(e.message));
	}

	if (!repos)
		return (
			<div className="settings-panel">
				<h1 className="settings-title">Warm previews</h1>
				<div className="setting-row-desc">{error || "Loading…"}</div>
			</div>
		);

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Warm previews</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				Keep a prebuilt template worktree per repo, refreshed from its default
				branch on a schedule (deps installed, dev server booted once so build
				caches are hot). New session worktrees copy those artifacts, so the
				Preview button starts in seconds instead of doing a cold build.
			</div>

			{error && (
				<div className="form-error" onClick={() => setError(null)}>
					{error}
				</div>
			)}

			<div className="setting-card">
				{repos.map((entry) => {
					const s = entry.state;
					const status = entry.refreshing
						? "Refreshing now — building the template…"
						: !entry.enabled
							? "Off — fresh worktrees build cold."
							: s?.ok
								? `Warm at ${s.sha} · refreshed ${warmAgo(s.refreshedAt)}${
										s.lastDurationMs
											? ` · took ${Math.round(s.lastDurationMs / 60_000)}m`
											: ""
									}`
								: s?.lastError
									? `Last refresh failed: ${s.lastError}`
									: "Enabled — first refresh runs shortly.";
					return (
						<SettingRow
							key={entry.repoId}
							title={entry.repoId}
							desc={status}
							control={
								<div className="flex items-center gap-2">
									{entry.enabled && (
										<>
											<button
												className="rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-dim transition-colors hover:border-faint hover:text-fg disabled:opacity-40"
												disabled={entry.refreshing}
												onClick={() =>
													apply(refreshWarmTemplateNow(entry.repoId))
												}
											>
												{entry.refreshing ? "Building…" : "Run now"}
											</button>
											<Select
												label={`Refresh interval for ${entry.repoId}`}
												value={String(entry.intervalHours)}
												options={WARM_INTERVAL_OPTIONS}
												onChange={(v) =>
													apply(
														updateWarmTemplate(entry.repoId, {
															intervalHours: parseInt(v, 10),
														}),
													)
												}
											/>
										</>
									)}
									<Toggle
										label={`Warm previews for ${entry.repoId}`}
										checked={entry.enabled}
										onChange={(v) =>
											apply(updateWarmTemplate(entry.repoId, { enabled: v }))
										}
									/>
								</div>
							}
						/>
					);
				})}
			</div>
		</div>
	);
}

/** Summarize one audit event for its row (the details live in the expand). */
function auditSummary(e: Record<string, unknown>): string {
	const parts: string[] = [];
	if (e.tool_name) parts.push(String(e.tool_name));
	if (e.action) parts.push(`${e.context ? `${e.context}.` : ""}${e.action}`);
	if (e.decision) parts.push(`decision: ${e.decision}`);
	if (e.account) parts.push(`account: ${e.account}`);
	if (e.model) parts.push(String(e.model));
	if (typeof e.ok === "boolean") parts.push(e.ok ? "ok" : "failed");
	if (e.error) parts.push(`error: ${String(e.error).slice(0, 80)}`);
	if (e.text_snippet) parts.push(`“${String(e.text_snippet).slice(0, 100)}”`);
	return parts.join(" · ");
}

/** Read-only viewer over ~/.backstage-audit daily JSONL (agent flight recorder). */
function AuditPanel() {
	const [dates, setDates] = useState<string[]>([]);
	const [date, setDate] = useState("");
	const [type, setType] = useState("");
	const [types, setTypes] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [all, setAll] = useState(false);
	const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
	const [total, setTotal] = useState(0);
	const [expanded, setExpanded] = useState<number | null>(null);
	const [loading, setLoading] = useState(true);

	// Debounced reload on any filter change.
	useEffect(() => {
		const t = setTimeout(() => {
			setLoading(true);
			fetchAudit({ date: date || undefined, type: type || undefined, q: q || undefined, all })
				.then((page) => {
					setDates(page.dates);
					if (!date && page.dates.length) {
						setDate(page.dates[0]);
						return; // effect re-runs with the date set
					}
					setEvents(page.events || []);
					setTotal(page.total || 0);
					setTypes(page.types || []);
					setExpanded(null);
					setLoading(false);
				})
				.catch(() => setLoading(false));
		}, 250);
		return () => clearTimeout(t);
	}, [date, type, q, all]);

	async function loadMore() {
		const page = await fetchAudit({
			date,
			type: type || undefined,
			q: q || undefined,
			all,
			offset: events.length,
		});
		setEvents([...events, ...(page.events || [])]);
	}

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Audit log</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				Every agent run's structured events — prompts, tool decisions, account
				switches, human confirmations. Read-only; files live under
				~/.backstage-audit (400-day retention).
			</div>

			<div className="flex flex-wrap items-center gap-2 mb-3 px-2.5">
				<select className="ui-select" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date">
					{dates.map((d) => (
						<option key={d} value={d}>
							{d}
						</option>
					))}
				</select>
				<select className="ui-select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type">
					<option value="">{all ? "All events" : "Significant events"}</option>
					{types.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				<label className="flex items-center gap-1.5 text-[12px] text-dim cursor-pointer">
					<input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
					include tool firehose
				</label>
				<input
					className="ui-select flex-1 min-w-[140px]"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search (session id, tool, text…)"
					aria-label="Search audit log"
				/>
			</div>

			<div className="text-faint text-[11.5px] mb-2 px-2.5">
				{loading ? "Loading…" : `${events.length} of ${total} events (newest first)`}
			</div>

			<div className="flex flex-col border border-line rounded-panel overflow-hidden bg-surface">
				{events.map((e, i) => {
					const time = String(e.time || "").slice(11, 19);
					const t = String(e.kind || e.msg || "event");
					const sid = typeof e.bks_session_id === "string" ? e.bks_session_id : "";
					return (
						<div key={i} className={`border-b border-line last:border-b-0 ${expanded === i ? "bg-panel" : ""}`}>
							<button
								className="w-full text-left flex items-baseline gap-2 px-2.5 py-1.5 text-[12px] cursor-pointer hover:bg-hover min-w-0"
								onClick={() => setExpanded(expanded === i ? null : i)}
							>
								<span className="font-mono text-faint shrink-0">{time}</span>
								<span className="text-fg font-medium shrink-0">{t}</span>
								{e.run_kind ? <span className="text-faint shrink-0">{String(e.run_kind)}</span> : null}
								<span className="text-dim truncate">{auditSummary(e)}</span>
								{sid && (
									<a
										className="text-faint font-mono text-[11px] ml-auto shrink-0 underline"
										href={`${BASE_PATH}/session/${sid}`}
										onClick={(ev) => ev.stopPropagation()}
									>
										{sid.slice(0, 18)}…
									</a>
								)}
							</button>
							{expanded === i && (
								<pre className="m-0 px-3 py-2 text-[11px] leading-relaxed text-dim overflow-x-auto border-t border-line">
									{JSON.stringify(e, null, 2)}
								</pre>
							)}
						</div>
					);
				})}
				{!loading && events.length === 0 && (
					<div className="px-3 py-4 text-faint text-[12.5px]">No events match.</div>
				)}
			</div>

			{events.length < total && (
				<div className="mt-2">
					<button className="btn-small" onClick={loadMore}>
						Load more ({total - events.length} left)
					</button>
				</div>
			)}
		</div>
	);
}

/** Composer preferences — per-browser, like theme (lib/send-key). */
function ComposerPanel() {
	const [sendKey, setSendKey] = useState<SendKeyPref>(getSendKeyPref);
	const [busySend, setBusySend] = useState<BusySendPref>(getBusySendPref);
	const [pinNew, setPinNew] = useState<boolean>(getPinNewSessions);
	const [pinNewWs, setPinNewWs] = useState<boolean>(getPinNewWorkspaces);
	useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
	useEffect(() => onBusySendChanged(() => setBusySend(getBusySendPref())), []);
	useEffect(
		() => onPinNewSessionsChanged(() => setPinNew(getPinNewSessions())),
		[],
	);
	useEffect(
		() => onPinNewWorkspacesChanged(() => setPinNewWs(getPinNewWorkspaces())),
		[],
	);

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Composer</h1>
			<div className="setting-card">
				<SettingRow
					title="Send messages with"
					desc={`Choose which key combination sends messages. Use ${
						sendKey === "mod-enter" ? "↵" : "⇧↵"
					} for new lines.`}
					control={
						<Select
							label="Send messages with"
							value={sendKey}
							options={[
								{ value: "enter", label: "Enter" },
								{ value: "mod-enter", label: MOD_ENTER_LABEL },
							]}
							onChange={setSendKeyPref}
						/>
					}
				/>
				<SettingRow
					title="Follow-up behavior"
					desc={
						<>
							Steer stops the current turn and delivers your message right
							away; Queue waits until the agent finishes.
							{sendKey === "enter" && (
								<div className="text-dim text-xs mt-1">
									Use {MOD_ENTER_GLYPH} to steer even when Queue is your
									default
								</div>
							)}
						</>
					}
					control={
						<Select
							label="Follow-up behavior"
							value={busySend}
							options={[
								{ value: "steer", label: "Steer" },
								{ value: "queue", label: "Queue" },
							]}
							onChange={setBusySendPref}
						/>
					}
				/>
				<SettingRow
					title="Pin new sessions"
					desc="Automatically pin a session to your tab strip when you start it."
					control={
						<Toggle
							label="Pin new sessions"
							checked={pinNew}
							onChange={setPinNewSessions}
						/>
					}
				/>
				<SettingRow
					title="Pin new workspaces"
					desc="Also pin a workspace to your tab strip when you create one."
					control={
						<Toggle
							label="Pin new workspaces"
							checked={pinNewWs}
							onChange={setPinNewWorkspaces}
						/>
					}
				/>
			</div>
		</div>
	);
}

// ── Workspace · General ─────────────────────────────────────────────────────

const IDENTITY_INPUT_CLASS =
	"w-[140px] rounded-md border border-line bg-surface px-2 py-1 text-[13px] font-medium text-dim opacity-70";

/**
 * Instance identity. The source of truth is ~/.backstage/config.json
 * (persona.name / branding.productName) on the server — there is no
 * settings-write API for the config file yet, so the fields render the
 * built-in defaults, disabled, until a read/write endpoint exists (the
 * needed backend change is documented in docs/rename-opensession-plan.md).
 */
function WorkspacePanel() {
	return (
		<div className="settings-panel">
			<h1 className="settings-title">General</h1>
			<div className="settings-group-label">Identity</div>
			<div className="setting-card">
				<SettingRow
					title="Agent name"
					desc={
						<>
							What the agent calls itself in prompts, Slack messages, and the
							UI. Configured via <code>persona.name</code> in{" "}
							<code>~/.backstage/config.json</code> on the server.
						</>
					}
					control={
						<Tooltip label="Wire-up pending. Edit ~/.backstage/config.json for now.">
							{/* Disabled inputs swallow hover events, so the tooltip
							    hangs off a wrapping span. */}
							<span className="inline-flex">
								<input
									className={IDENTITY_INPUT_CLASS}
									value={AGENT_NAME}
									disabled
									readOnly
									aria-label="Agent name"
								/>
							</span>
						</Tooltip>
					}
				/>
				<SettingRow
					title="Product name"
					desc={
						<>
							What this app calls itself in titles and headers. Configured via{" "}
							<code>branding.productName</code> in the same config file.
						</>
					}
					control={
						<Tooltip label="Wire-up pending. Edit ~/.backstage/config.json for now.">
							<span className="inline-flex">
								<input
									className={IDENTITY_INPUT_CLASS}
									value={PRODUCT_NAME}
									disabled
									readOnly
									aria-label="Product name"
								/>
							</span>
						</Tooltip>
					}
				/>
			</div>
			<div className="settings-hint">
				Changes to the config file apply to new runs without a restart; a
				settings-write API for these fields is pending.
			</div>
		</div>
	);
}

function AppearancePanel() {
	const [pref, setPref] = useState<ThemePref>(getThemePref);
	useEffect(() => onThemeChanged(() => setPref(getThemePref())), []);
	const [wsTime, setWsTime] = useState<WsTimePref>(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTime(getWsTimePref())), []);
	const [turnActivity, setTurnActivity] =
		useState<TurnActivityPref>(getTurnActivityPref);
	useEffect(
		() => onTurnActivityChanged(() => setTurnActivity(getTurnActivityPref())),
		[],
	);

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Appearance</h1>
			<div className="settings-group-label">Theme</div>
			<div className="theme-cards" role="radiogroup" aria-label="Theme">
				{THEME_OPTIONS.map((o) => (
					<ThemeCard
						key={o.value}
						option={o.value}
						active={pref === o.value}
						onClick={() => {
							setThemePref(o.value);
							setPref(o.value);
						}}
					/>
				))}
			</div>
			<div className="settings-hint">
				{pref === "system"
					? "Matches your operating system."
					: `Always ${pref} mode.`}
			</div>

			<div className="settings-group-label" style={{ marginTop: 22 }}>
				Chat
			</div>
			<div className="setting-card">
				<SettingRow
					title="Tool calls & messages"
					desc="How each turn's working — tool calls and in-between messages — folds in the chat. Expand while running shows the work live and collapses it once the turn finishes."
					control={
						<Select
							label="Tool calls & messages"
							value={turnActivity}
							options={[
								{ value: "auto", label: "Expand while running" },
								{ value: "expanded", label: "Always expanded" },
								{ value: "collapsed", label: "Always collapsed" },
							]}
							onChange={setTurnActivityPref}
						/>
					}
				/>
			</div>

			<div className="settings-group-label" style={{ marginTop: 22 }}>
				Sidebar
			</div>
			<div className="setting-card">
				<SettingRow
					title="Show last used time"
					desc="Show when each workspace was last active in the sidebar. A live run always shows its running time regardless."
					control={
						<Select
							label="Show last used time"
							value={wsTime}
							options={[
								{ value: "off", label: "Off" },
								{ value: "always", label: "Always" },
								{ value: "hover", label: "On hover" },
							]}
							onChange={setWsTimePref}
						/>
					}
				/>
			</div>
		</div>
	);
}
