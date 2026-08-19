import React, { useEffect, useState } from "react";
import { IconCheck } from "../icons";
import { fetchFeeds } from "../../lib/api";
import {
	ACCENT_THEME_OPTIONS,
	getAccentTheme,
	getAccentThemeOption,
	getOnAccentInk,
	onAccentThemeChanged,
	setAccentTheme,
	type AccentTheme,
} from "../../lib/accent-theme";
import {
	onSidebarFeedsChanged,
	readHiddenSidebarFeeds,
	setSidebarFeedVisible,
} from "../../lib/sidebar-feeds";
import {
	onSidebarToolsChanged,
	readHiddenSidebarTools,
	setSidebarToolVisible,
	toolFitsViewport,
	SIDEBAR_TOOL_IDS,
	SIDEBAR_TOOL_LABELS,
} from "../../lib/sidebar-tools";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
	getThemePref,
	effectiveTheme,
	onThemeChanged,
	setThemePref,
	type ThemePref,
} from "../../lib/theme";
import type { FeedDescriptor } from "../../lib/types";
import {
	getWsTimePref,
	onWsTimeChanged,
	setWsTimePref,
	type WsTimePref,
} from "../../lib/workspace-time";
import {
	DENSITY_OPTIONS,
	getSidebarDensity,
	onSidebarDensityChanged,
	setSidebarDensity,
	type SidebarDensity,
} from "../../lib/sidebar-density";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import {
	PLAIN_ID,
	SUPPORT_SURFACE_OPTIONS,
	setSupportSurface,
	supportSurfaceOf,
	type SupportSurface,
} from "../../lib/support-surface";
import {
	SettingCard,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsPanel,
	SettingsSection,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { Select, SettingRow } from "./shared";

// ── Appearance ─────────────────────────────────────────────────────────────

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

/**
 * Fixed palettes for the miniature mockup below — deliberately raw values
 * rather than theme tokens, because each swatch has to keep showing its own
 * tone no matter which theme is active. Applied as custom properties so the
 * mock's parts can stay plain utilities.
 */
const MOCK_PALETTE: Record<"light" | "dark", React.CSSProperties> = {
	light: {
		"--mk-bg": "#e9e9e9",
		"--mk-panel": "#ffffff",
		"--mk-line": "#d5d5d5",
		"--mk-pill": "#cbcbcb",
	} as React.CSSProperties,
	dark: {
		"--mk-bg": "#565656",
		"--mk-panel": "#3e3e3e",
		"--mk-line": "#c4c4c4",
		"--mk-pill": "#8a8a8a",
	} as React.CSSProperties,
};

// A miniature app mockup used inside the theme swatches. Its proportions are
// percentages of the swatch rather than scale steps — it is an illustration
// that has to rescale with the card, not a piece of chrome on the grid.
function ThemeMock({ tone }: { tone: "light" | "dark" }) {
	return (
		<div
			className="absolute inset-0 bg-(--mk-bg) pt-[15%]"
			style={MOCK_PALETTE[tone]}
		>
			<div className="mb-[9px] flex flex-col items-center gap-[5px]">
				<div className="h-1.5 w-[56%] rounded-sm bg-(--mk-pill)" />
				<div className="h-1.5 w-[42%] rounded-sm bg-(--mk-pill) opacity-65" />
			</div>
			<div className="mr-[9%] ml-[14%] flex h-[56%] flex-col gap-2 rounded-t-md bg-(--mk-panel) px-3 py-[11px]">
				<div className="h-1.5 w-[68%] rounded-xs bg-(--mk-line)" />
				<div className="h-1.5 w-[84%] rounded-xs bg-(--mk-line)" />
				<div className="h-1.5 w-[56%] rounded-xs bg-(--mk-line)" />
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
		// Selection reads off `data-active` rather than an `.active` class so the
		// swatch and label can style themselves with group-data-* variants. The
		// old rules were compound selectors (`.theme-card.active .theme-swatch`),
		// which outrank a single utility — leaving the class here would have let
		// it keep winning against everything below.
		<button
			className="group flex cursor-pointer flex-col items-center gap-2.5 border-none bg-transparent p-0"
			role="radio"
			aria-checked={active}
			data-active={active || undefined}
			onClick={onClick}
		>
			<div className="relative aspect-16/10 w-full overflow-hidden rounded-row border-2 border-line transition-[border-color,box-shadow] group-hover:border-faint group-data-active:border-accent group-data-active:shadow-[0_0_0_1px_var(--accent)]">
				{/* System = light base with the dark mock clipped over the right half. */}
				<ThemeMock tone={option === "dark" ? "dark" : "light"} />
				{option === "system" && (
					<div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
						<ThemeMock tone="dark" />
					</div>
				)}
			</div>
			<span className="text-label text-dim group-data-active:font-semibold group-data-active:text-fg">
				{label}
			</span>
		</button>
	);
}

function AccentSwatch({
	theme,
	active,
	tone,
	onClick,
}: {
	theme: AccentTheme;
	active: boolean;
	tone: "light" | "dark";
	onClick: () => void;
}) {
	const option = getAccentThemeOption(theme);
	const swatch = option[tone];
	const ink = getOnAccentInk(theme, tone);
	const style = {
		"--swatch": swatch,
		"--swatch-ink": ink,
	} as React.CSSProperties;

	return (
		<label
			className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md p-1"
			title={option.label}
			style={style}
		>
			<input
				type="radio"
				name="accent-theme"
				value={theme}
				checked={active}
				onChange={onClick}
				aria-label={option.label}
				className="peer sr-only"
			/>
			<span className="flex size-8 items-center justify-center rounded-full border border-line bg-[linear-gradient(135deg,color-mix(in_srgb,var(--swatch)_97%,white),color-mix(in_srgb,var(--swatch)_94%,black))] text-(--swatch-ink) outline-offset-4 transition-[scale,box-shadow] duration-150 active:scale-[0.96] peer-checked:shadow-[0_0_0_2px_var(--bg-raised),0_0_0_4px_var(--swatch)] peer-focus-visible:outline-2 peer-focus-visible:outline-accent-ink">
				{active && <IconCheck size={16} strokeWidth={2.4} />}
			</span>
		</label>
	);
}

// ── Workspace · General ─────────────────────────────────────────────────────

/** Text field that commits on blur/Enter (Esc reverts), for the identity
 *  settings backed by the config file rather than local prefs. */
/**
 * Instance identity. The source of truth is ~/.opensession/config.json
 * (persona.name / branding.productName) on the server, read and written
 * through /api/settings/identity. A save applies to new runs immediately and
 * schedules a frontend rebuild, so open tabs get the update-pill nudge once
 * the re-branded bundle is live.
 */
export function AppearancePanel() {
	const isPhone = useIsPhone();
	const [pref, setPref] = useState<ThemePref>(getThemePref);
	const [tone, setTone] = useState(effectiveTheme);
	useEffect(
		() =>
			onThemeChanged(() => {
				setPref(getThemePref());
				setTone(effectiveTheme());
			}),
		[],
	);
	const [accent, setAccent] = useState<AccentTheme>(getAccentTheme);
	useEffect(
		() => onAccentThemeChanged(() => setAccent(getAccentTheme())),
		[],
	);
	const [wsTime, setWsTime] = useState<WsTimePref>(getWsTimePref);
	useEffect(() => onWsTimeChanged(() => setWsTime(getWsTimePref())), []);
	const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
	useEffect(
		() => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
		[],
	);
	const [hiddenSidebarTools, setHiddenSidebarTools] = useState(
		readHiddenSidebarTools,
	);
	const [sidebarFeeds, setSidebarFeeds] = useState<FeedDescriptor[]>([]);
	const [hiddenSidebarFeeds, setHiddenSidebarFeeds] = useState(
		readHiddenSidebarFeeds,
	);
	useEffect(() => {
		let alive = true;
		fetchFeeds()
			.then((feeds) => {
				if (alive) setSidebarFeeds(feeds);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	useEffect(
		() =>
			onSidebarToolsChanged(() =>
				setHiddenSidebarTools(readHiddenSidebarTools()),
			),
		[],
	);
	useEffect(
		() =>
			onSidebarFeedsChanged(() =>
				setHiddenSidebarFeeds(readHiddenSidebarFeeds()),
			),
		[],
	);

	return (
		<SettingsPanel>
			<SettingsHeader title="Appearance" />
			<SettingsGroupLabel className="mt-0">Theme</SettingsGroupLabel>
			<SettingsSection>
				<div
					className="grid grid-cols-3 gap-3.5"
					role="radiogroup"
					aria-label="Theme"
				>
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
			</SettingsSection>

			<SettingsGroupLabel>Accent</SettingsGroupLabel>
			<SettingsSection>
				<div
					// One row per breakpoint, so the column count tracks
					// ACCENT_THEME_OPTIONS.length. A single swatch wrapping onto its
					// own line reads as a mistake; accent-theme.test.ts guards it.
					className="grid grid-cols-4 gap-2 desktop:grid-cols-7"
					role="radiogroup"
					aria-label="Accent colour"
				>
					{ACCENT_THEME_OPTIONS.map((option) => (
						<AccentSwatch
							key={option.value}
							theme={option.value}
							active={accent === option.value}
							tone={tone}
							onClick={() => {
								setAccentTheme(option.value);
								setAccent(option.value);
							}}
						/>
					))}
				</div>
			</SettingsSection>

			<SettingsGroupLabel>
				Sidebar
			</SettingsGroupLabel>
			<SettingCard>
				<SettingRow
					title="Row density"
					control={
						// Two named choices rather than a switch: the same pair the
						// sidebar's filter menu offers, in the same control, wearing the
						// same marks, so the two ways in read as one setting.
						<Segmented
							label="Sidebar row density"
							value={density}
							onValueChange={(v) => setSidebarDensity(v as SidebarDensity)}
						>
							{DENSITY_OPTIONS.map(({ value, label, Icon }) => (
								<SegmentedOption key={value} value={value}>
									<Icon size={20} />
									{label}
								</SegmentedOption>
							))}
						</Segmented>
					}
				/>
				<SettingRow
					title="Show last used time"
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
				{/* Support is one decision, not two switches. Its tool and its
				    sidebar band are the same queue reached two ways, so they are
				    set together here and left out of the lists below. Only
				    offered when Plain is actually connected: with no queue behind
				    it there is nowhere for either surface to lead. */}
				{sidebarFeeds.some((feed) => feed.id === PLAIN_ID) && (
					<SettingRow
						title="Support tickets"
						desc="Choose where Plain tickets live: in a full workspace from the sidebar, or beside the queue without chat."
						control={
							<Select
								label="Where support tickets live"
								value={supportSurfaceOf(
									!hiddenSidebarTools.has(PLAIN_ID),
									!hiddenSidebarFeeds.has(PLAIN_ID),
								)}
								options={SUPPORT_SURFACE_OPTIONS}
								onChange={(value) =>
									setSupportSurface(value as SupportSurface)
								}
							/>
						}
					/>
				)}
				{SIDEBAR_TOOL_IDS.filter(
					(toolId) =>
						toolFitsViewport(toolId, isPhone) && toolId !== PLAIN_ID,
				).map((toolId) => (
					<SettingRow
						key={toolId}
						title={SIDEBAR_TOOL_LABELS[toolId]}
						control={
							<Switch
								aria-label={`Show ${SIDEBAR_TOOL_LABELS[toolId]} in sidebar`}
								checked={!hiddenSidebarTools.has(toolId)}
								onCheckedChange={(visible) =>
									setSidebarToolVisible(toolId, visible)
								}
							/>
						}
					/>
				))}
				{sidebarFeeds
					.filter((feed) => feed.id !== PLAIN_ID)
					.map((feed) => (
						<SettingRow
							key={feed.id}
							title={feed.title}
							desc="Hidden sources stop refreshing until shown again."
							control={
								<Switch
									aria-label={`Show ${feed.title} in sidebar`}
									checked={!hiddenSidebarFeeds.has(feed.id)}
									onCheckedChange={(visible) =>
										setSidebarFeedVisible(feed.id, visible)
									}
								/>
							}
						/>
					))}
			</SettingCard>
		</SettingsPanel>
	);
}
