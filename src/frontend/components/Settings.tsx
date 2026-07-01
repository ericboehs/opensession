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
import { Connections, DefaultModel } from "./Connections";

// The full-window Settings surface: a left sub-nav + a scrolling body, reached
// from the "Settings" item in the Michael menu. Designed to grow — each area is
// just another entry in SECTIONS and a matching panel below. The "Personal" group
// holds per-browser preferences (notifications, theme); the "Workspace" group holds
// shared setup that configures how every session runs (default model, connections).

type SectionKey = "notifications" | "appearance" | "model" | "connections";

const SECTIONS: {
	key: SectionKey;
	label: string;
	group: string;
	icon: React.ReactNode;
}[] = [
	{
		key: "notifications",
		label: "Notifications",
		group: "Personal",
		icon: (
			<svg
				width="15"
				height="15"
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
		key: "appearance",
		label: "Appearance",
		group: "Personal",
		icon: (
			<svg
				width="15"
				height="15"
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
		key: "model",
		label: "Default model",
		group: "Workspace",
		icon: (
			<svg
				width="15"
				height="15"
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
		key: "connections",
		label: "Connections",
		group: "Workspace",
		icon: (
			<svg
				width="15"
				height="15"
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
];

export function Settings({ onBack }: { onBack: () => void }) {
	const [section, setSection] = useState<SectionKey>("notifications");

	// Esc returns to the app.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onBack();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onBack]);

	// Group the nav entries under their group label (order preserved).
	const groups: { group: string; items: typeof SECTIONS }[] = [];
	for (const s of SECTIONS) {
		let g = groups.find((x) => x.group === s.group);
		if (!g) groups.push((g = { group: s.group, items: [] }));
		g.items.push(s);
	}

	return (
		<div className="settings-page">
			<aside className="settings-sidenav">
				<button className="settings-back" onClick={onBack}>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
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
									section === s.key ? "active" : ""
								}`}
								onClick={() => setSection(s.key)}
							>
								<span className="settings-sidenav-icon">{s.icon}</span>
								{s.label}
							</button>
						))}
					</div>
				))}
			</aside>

			<div className="settings-content">
				{section === "notifications" && <NotificationsPanel />}
				{section === "appearance" && <AppearancePanel />}
				{section === "model" && <DefaultModelPanel />}
				{section === "connections" && <Connections />}
			</div>
		</div>
	);
}

// ── Reusable controls ──────────────────────────────────────────────────────

function SettingRow({
	title,
	desc,
	control,
}: {
	title: string;
	desc: string;
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
								<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
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

function AppearancePanel() {
	const [pref, setPref] = useState<ThemePref>(getThemePref);
	useEffect(() => onThemeChanged(() => setPref(getThemePref())), []);

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
		</div>
	);
}

// ── Default model ──────────────────────────────────────────────────────────
// A thin Settings wrapper around the DefaultModel control (which owns the fetch
// + save). The panel supplies the heading; the control renders the picker card.

function DefaultModelPanel() {
	return (
		<div className="settings-panel">
			<h1 className="settings-title">Default model</h1>
			<div className="settings-group-label">What new sessions run on</div>
			<DefaultModel />
		</div>
	);
}
