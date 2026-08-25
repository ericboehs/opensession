import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, PRODUCT_NAME } from "../lib/brand";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { Button } from "../ui/button";
import { duration, ease } from "../ui/motion";
import { LoadingState } from "../ui/state";
import { TopBar } from "../ui/top-bar";
import { BrandMark } from "./BrandTile";
import { GithubAuthCard } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { TeamSection } from "./SetupTeam";
import { UserAvatar } from "./UserAvatar";
import { OrganizationProfileSection } from "./settings/GeneralPanel";
import { ProviderAccountsSection } from "./settings/ModelAccounts";
import { IconCheck, IconChevronLeft, IconGlobe, IconRepo } from "./icons";
import { githubAuthState, type SetupStatus } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap15: {
			gap: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	bgBg65: {
			backgroundColor: "var(--bg)"
	},
	py1: {
			paddingBlock: "4px"
	},
	pr2: {
			paddingRight: "8px"
	},
	pl1: {
			paddingLeft: "4px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	size6: {
			width: "24px",
			height: "24px"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	bgBg85: {
			backgroundColor: "var(--bg)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	relative: {
			position: "relative"
	},
	absolute: {
			position: "absolute"
	},
	Right05: {
			right: "-2px"
	},
	Bottom05: {
			bottom: "-2px"
	},
	size25: {
			width: "10px",
			height: "10px"
	},
	bgFg: {
			backgroundColor: "var(--text)"
	},
	textBg: {
			color: "var(--bg)"
	},
	ringBg: { "--tw-ring-color": "var(--bg)" },
	size7: {
			width: "28px",
			height: "28px"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderBg: {
			borderColor: "var(--bg)"
	},
	grid: {
			display: "grid"
	},
	gridCols5: {
			gridTemplateColumns: "repeat(5,minmax(0,1fr))"
	},
	gap3: {
			gap: "12px"
	},
	minW0: {
			minWidth: "0"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap2: {
			gap: "8px"
	},
	size2: {
			width: "8px",
			height: "8px"
	},
	bgCurrent: {
			backgroundColor: "currentColor"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	mt1: {
			marginTop: "4px"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	h100dvh: {
			height: "100dvh"
	},
	wFull: {
			width: "100%"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	bgBg: {
			backgroundColor: "var(--bg)"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	inset0: {
			inset: "0"
	},
	opacity70: {
			opacity: ".7"
	},
	z10: {
			zIndex: "10"
	},
	gridCols1frAuto1fr: {
			gridTemplateColumns: "1fr auto 1fr"
	},
	px8: {
			paddingInline: "32px"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	colStart3: {
			gridColumnStart: "3"
	},
	minH9: {
			minHeight: "36px"
	},
	justifySelfEnd: {
			justifySelf: "flex-end"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	},
	px3: {
			paddingInline: "12px"
	},
	minH0: {
			minHeight: "0"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	px6: {
			paddingInline: "24px"
	},
	ScrollbarWidthThin: {
			scrollbarWidth: "thin"
	},
	hFull: {
			height: "100%"
	},
	maxW560px: {
			maxWidth: "560px"
	},
	flexCol: {
			flexDirection: "column"
	},
	textCenter: {
			textAlign: "center"
	},
	mb7: {
			marginBottom: "28px"
	},
	size20: {
			width: "80px",
			height: "80px"
	},
	scale113: {
			scale: "1.13"
	},
	m0: {
			margin: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	leading108: {
			lineHeight: "1.08"
	},
	tracking003em: {
			letterSpacing: "-.03em"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	mt3: {
			marginTop: "12px"
	},
	maxW440px: {
			maxWidth: "440px"
	},
	textPretty: {
			textWrap: "pretty"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	mt7: {
			marginTop: "28px"
	},
	maxW300px: {
			maxWidth: "300px"
	},
	minH11: {
			minHeight: "44px"
	},
	mb8: {
			marginBottom: "32px"
	},
	maxW700px: {
			maxWidth: "700px"
	},
	textBalance: {
			textWrap: "balance"
	},
	tracking0035em: {
			letterSpacing: "-.035em"
	},
	maxW820px: {
			maxWidth: "820px"
	},
	pb8: {
			paddingBottom: "32px"
	},
	mxAuto: {
			marginInline: "auto"
	},
	previewOverflow: {
		display: "flex", width: "28px", height: "28px", alignItems: "center", justifyContent: "center",
		borderRadius: "calc(infinity * 1px)", borderStyle: "solid", borderWidth: "1px",
		fontWeight: "var(--font-weight-semibold)", color: "var(--text-dim)",
	},
	previewOverflowOpaque: { borderColor: "var(--bg)", backgroundColor: "color-mix(in oklab, var(--bg) 85%, transparent)" },
	previewOverflowTransparent: { borderColor: "transparent", backgroundColor: "transparent" },
	summaryTile: {
		display: "flex", aspectRatio: "1 / 1", minWidth: 0, flexDirection: "column",
		justifyContent: "space-between", borderRadius: "calc(22px * var(--rf))",
		borderStyle: "solid", borderWidth: "1px", padding: "16px", textAlign: "left",
		backdropFilter: "blur(var(--blur-xl))",
		"@media (max-width: 720px)": { borderRadius: "calc(18px * var(--rf))", padding: "14px" },
	},
	summaryTileInteractive: {
		cursor: "pointer", transitionProperty: "transform, filter", transitionDuration: "150ms",
		transitionTimingFunction: "var(--ease)",
		":focusVisible": { outline: "2px solid var(--accent-ink)", outlineOffset: "2px" },
		"@media (forced-colors: active)": { ":focusVisible": { outlineColor: "Highlight" } },
		":hover": { filter: "brightness(0.98)" },
		":active": { transform: "scale(0.96)" },
		"@media (prefers-reduced-motion: reduce)": { transform: "none" },
	},
	summaryTileReady: {
		borderColor: "transparent", backgroundColor: "var(--green-soft)",
		boxShadow: "inset 0 1px 0 color-mix(in srgb, white 45%, transparent), 0 12px 28px -24px color-mix(in srgb, var(--green) 45%, transparent)",
	},
	summaryTilePending: { borderColor: "var(--divider-soft)", backgroundColor: "color-mix(in oklab, var(--settings-plate) 65%, transparent)" },
	tileStatus: {
		display: "flex", width: "32px", height: "32px", flexShrink: 0,
		alignItems: "center", justifyContent: "center", borderRadius: "calc(infinity * 1px)",
	},
	tileStatusReady: { backgroundColor: "color-mix(in oklab, var(--bg) 60%, transparent)", color: "var(--green)" },
	tileStatusPending: { backgroundColor: "color-mix(in oklab, var(--text-faint) 10%, transparent)", color: "var(--text-faint)" },
	phoneBackButton: {
		display: "none", justifySelf: "start",
		"@media (max-width: 720px)": { display: "flex", width: "40px", height: "40px", justifyContent: "center", padding: 0 },
	},
	phoneInvisible: { "@media (max-width: 720px)": { visibility: "hidden" } },
	progressNav: { position: "absolute", left: "50%", display: "flex", transform: "translateX(-50%)", alignItems: "center", gap: "8px" },
	invisible: { visibility: "hidden" },
	progressStep: {
		height: "8px", cursor: "pointer", borderRadius: "calc(infinity * 1px)",
		transitionProperty: "width, background-color", transitionDuration: "200ms",
		transitionTimingFunction: "var(--ease)",
		":focusVisible": { outline: "2px solid var(--accent-ink)", outlineOffset: "2px" },
		"@media (forced-colors: active)": { ":focusVisible": { outlineColor: "Highlight" } },
	},
	progressCurrent: { width: "32px", backgroundColor: "var(--text)" },
	progressComplete: { width: "8px", backgroundColor: "color-mix(in oklab, var(--text) 45%, transparent)" },
	progressUpcoming: {
		width: "8px", backgroundColor: "color-mix(in oklab, var(--text-faint) 35%, transparent)",
		":hover": { backgroundColor: "color-mix(in oklab, var(--text-faint) 60%, transparent)" },
	},
	stepSection: {
		marginInline: "auto", display: "flex", minHeight: "100%", width: "100%", maxWidth: "960px",
		flexDirection: "column", alignItems: "center", paddingBlock: "32px",
		"@media (max-width: 720px)": { paddingBlock: "20px" },
	},
	welcomeStep: { justifyContent: "center", paddingBottom: "64px", "@media (max-width: 720px)": { paddingBottom: "40px" } },
	footer: {
		position: "relative", zIndex: 10, borderTopStyle: "solid", borderTopWidth: "1px",
		paddingInline: "32px", paddingTop: "4px", transitionProperty: "border-color, background-color",
		transitionDuration: "var(--dur-micro)", transitionTimingFunction: "var(--ease)",
		"@media (max-width: 720px)": { paddingInline: "20px", paddingTop: "12px" },
	},
	footerSeparated: {
		borderTopColor: "var(--border)", backgroundColor: "color-mix(in oklab, var(--bg) 95%, transparent)",
		backdropFilter: "blur(var(--blur-xl))",
	},
	footerAttached: { borderTopColor: "transparent", backgroundImage: "linear-gradient(to bottom, transparent, var(--bg) 30%)" },
	desktopBackButton: { justifySelf: "start", "@media (max-width: 720px)": { display: "none" } },
});

interface FirstMileStep {
	id: "welcome" | "github" | "organization" | "team" | "ai" | "repos" | "ready";
	label: string;
	title: string;
	description: string;
}

// GitHub comes first because it supplies the next step's answers: the
// organization is named, marked and domained from the org you just connected,
// rather than asked for cold. Members sit after repositories, since an invite
// is worth more once there is something to join.
const STEPS: FirstMileStep[] = [
	{
		id: "welcome",
		label: "Welcome",
		title: `Welcome to ${PRODUCT_NAME}`,
		description: "Create a new organization or join one your team has already set up.",
	},
	{
		id: "github",
		label: "GitHub",
		title: "Connect GitHub",
		description: "Give sessions access to your repositories and pull requests.",
	},
	{
		id: "organization",
		label: "Organization",
		title: "Your organization",
		description: "Choose how your organization appears to your team in Open Session.",
	},
	{
		id: "ai",
		label: "Models",
		title: "Models",
		description: "Connect the AI subscriptions your team will use to run sessions.",
	},
	{
		id: "repos",
		label: "Repositories",
		title: "Repositories",
		description: "Add the repositories you want sessions to work in.",
	},
	{
		id: "team",
		label: "Members",
		title: "Invite your team",
		description: "Invite teammates from your GitHub organization to work with you.",
	},
	{
		id: "ready",
		label: "Ready",
		title: "You’re ready",
		description: "Review your setup before entering Open Session.",
	},
];

/** The GitHub organization this instance is wired to, for the organization
 *  step's defaults. Reads the App's own owner first, then falls back to the
 *  org named in the App-create URL the wizard built. */
function connectedGithubOrganization(status: SetupStatus): string {
	if (status.github.appOrg) return status.github.appOrg;
	try {
		const match = new URL(status.github.appCreateUrl).pathname.match(
			/^\/organizations\/([^/]+)/,
		);
		return match?.[1] ? decodeURIComponent(match[1]) : "";
	} catch {
		return "";
	}
}

function PreviewOverflow({
	count,
	transparent = false,
}: {
	count: number;
	transparent?: boolean;
}) {
	if (count <= 0) return null;
	return (
		<span
			{...stylex.props(
				sx.previewOverflow,
				typography.meta,
				transparent ? sx.previewOverflowTransparent : sx.previewOverflowOpaque,
			)}
		>
			+{count}
		</span>
	);
}

function FirstMileSummary({
	status,
	onSelect,
}: {
	status: SetupStatus;
	onSelect: (step: FirstMileStep["id"]) => void;
}) {
	const github = githubAuthState(status.github);
	let serverHost = status.publicBaseUrl;
	try {
		serverHost = new URL(status.publicBaseUrl).host;
	} catch {}
	let githubOrganization = status.github.appOrg || "";
	if (!githubOrganization) {
		try {
			const match = new URL(status.github.appCreateUrl).pathname.match(/^\/organizations\/([^/]+)/);
			githubOrganization = match?.[1] ? decodeURIComponent(match[1]) : "";
		} catch {}
	}
	const accountCount = status.engine.claudeAccounts + status.engine.codexAccounts;
	const accounts = [
		...Array.from({ length: status.engine.claudeAccounts }, () => ({
			label: "Claude subscription",
			provider: "claude" as const,
		})),
		...Array.from({ length: status.engine.codexAccounts }, () => ({
			label: "OpenAI subscription",
			provider: "codex" as const,
		})),
	];
	const tiles = [
		{
			title: "Server",
			step: null,
			ready: true,
			label: "Online",
			preview: (
				<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.gap15, sx.roundedFull, sx.bgBg65, sx.py1, sx.pr2, sx.pl1, sx.fontMedium, sx.textFg, typography.meta)}>
					<span {...stylex.props(sx.flex, sx.size6, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgBg85, sx.textDim)}>
						<IconGlobe size={15} />
					</span>
					<span {...stylex.props(sx.truncate)}>{serverHost}</span>
				</div>
			),
		},
		{
			title: "GitHub",
			step: "github" as const,
			ready: github.tone === "on",
			label: github.label,
			preview: (
				<div {...stylex.props(sx.flex, sx.maxWFull, sx.itemsCenter, sx.gap15, sx.roundedFull, sx.bgBg65, sx.py1, sx.pr2, sx.pl1, sx.fontMedium, sx.textFg, typography.meta)}>
					{githubOrganization ? (
						<span {...stylex.props(sx.relative, sx.flex, sx.size6, sx.shrink0)}>
							<UserAvatar
								name={githubOrganization}
								login={githubOrganization}
								size={24}
								{...stylex.props(sx.roundedFull)}
							/>
							<span {...mergeStylexProps("ring-1", sx.absolute, sx.Right05, sx.Bottom05, sx.flex, sx.size25, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgFg, sx.textBg, sx.ringBg)}>
								<BrandMark name="github" size={7} />
							</span>
						</span>
					) : (
						<span {...stylex.props(sx.flex, sx.size6, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgFg, sx.textBg)}>
							<BrandMark name="github" size={15} />
						</span>
					)}
					<span {...stylex.props(sx.truncate)}>{githubOrganization || "GitHub"}</span>
				</div>
			),
		},
		{
			title: "AI subscriptions",
			step: "ai" as const,
			ready: status.engine.ready,
			label: `${accountCount} ${accountCount === 1 ? "account" : "accounts"} connected`,
			preview: (
				<div {...mergeStylexProps("-space-x-2", sx.flex)}>
					{accounts.slice(0, 4).map((account, index) => (
						<span
							key={`${account.provider}-${index}`}
							title={account.label}
							{...stylex.props(sx.flex, sx.size7, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderBg, sx.bgBg85, sx.textFg)}
						>
							<BrandMark name={account.provider} size={15} />
						</span>
					))}
					<PreviewOverflow count={accounts.length - 4} />
				</div>
			),
		},
		{
			title: "Repositories",
			step: "repos" as const,
			ready: status.repos.length > 0,
			label: status.repos.length > 0 ? `${status.repos.length} added` : "None added",
			preview: (
				<div {...mergeStylexProps("-space-x-2", sx.flex)}>
					{status.repos.slice(0, 4).map((repo) => (
						<span
							key={repo.id}
							title={repo.label}
							{...stylex.props(sx.flex, sx.size7, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderBg, sx.bgBg85, sx.textDim)}
						>
							<IconRepo size={14} />
						</span>
					))}
					<PreviewOverflow count={status.repos.length - 4} />
				</div>
			),
		},
		{
			title: "Team",
			step: "team" as const,
			ready: status.team.count > 0,
			label:
				status.team.count > 0
					? `${status.team.count} ${status.team.count === 1 ? "member" : "members"}`
					: "No members",
			preview: (
				<div {...mergeStylexProps("-space-x-2", sx.flex)}>
					{status.team.names.slice(0, 4).map((name) => (
						<UserAvatar key={name} name={name} size={28} {...stylex.props(sx.border, sx.borderBg)} />
					))}
					<PreviewOverflow count={status.team.names.length - 4} transparent />
				</div>
			),
		},
	];

	return (
		<div {...mergeStylexProps("phone:grid-cols-2", sx.grid, sx.gridCols5, sx.gap3)}>
			{tiles.map((tile) => {
				const tileProps = stylex.props(
					sx.summaryTile,
					tile.step && sx.summaryTileInteractive,
					tile.ready ? sx.summaryTileReady : sx.summaryTilePending,
				);
				const content = (
					<>
						<div {...stylex.props(sx.flex, sx.minW0, sx.itemsStart, sx.justifyBetween, sx.gap2)}>
							<div {...stylex.props(sx.minW0)}>{tile.preview}</div>
							<div
								{...stylex.props(
									sx.tileStatus,
									tile.ready ? sx.tileStatusReady : sx.tileStatusPending,
								)}
							>
								{tile.ready ? (
									<IconCheck size={18} />
								) : (
									<span {...stylex.props(sx.size2, sx.roundedFull, sx.bgCurrent)} />
								)}
							</div>
						</div>
						<div {...stylex.props(sx.minW0)}>
							<div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>{tile.title}</div>
							<div {...stylex.props(sx.mt1, sx.leadingSnug, sx.textDim, typography.supporting)}>{tile.label}</div>
						</div>
					</>
				);
				return tile.step ? (
					<button
						type="button"
						key={tile.title}
						onClick={() => onSelect(tile.step)}
						aria-label={`Edit ${tile.title}`}
						{...tileProps}
					>
						{content}
					</button>
				) : (
					<div key={tile.title} {...tileProps}>
						{content}
					</div>
				);
			})}
		</div>
	);
}

export function FirstMile({ onDone }: { onDone: () => void }) {
	const setup = useSetupStatus();
	const { status, failed, refetch } = setup;
	const [index, setIndex] = useState(0);
	const [direction, setDirection] = useState(1);
	const [footerSeparated, setFooterSeparated] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const mainRef = useRef<HTMLElement>(null);
	const reducedMotion = useReducedMotion();
	const step = STEPS[index]!;

	useEffect(() => {
		document.title = `Welcome to ${PRODUCT_NAME}`;
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, []);

	useEffect(() => {
		if (index > 0) headingRef.current?.focus({ preventScroll: true });
	}, [index]);

	useEffect(() => {
		const main = mainRef.current;
		if (!main) return;
		const update = () => {
			const remaining = main.scrollHeight - main.scrollTop - main.clientHeight;
			setFooterSeparated(remaining > 1);
		};
		update();
		main.addEventListener("scroll", update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(main);
		const mutation = new MutationObserver(update);
		mutation.observe(main, { childList: true, subtree: true });
		return () => {
			main.removeEventListener("scroll", update);
			resize.disconnect();
			mutation.disconnect();
		};
	}, [index, status]);

	function goTo(next: number) {
		const nextIndex = Math.min(Math.max(next, 0), STEPS.length - 1);
		if (nextIndex === index) return;
		setDirection(nextIndex > index ? 1 : -1);
		setIndex(nextIndex);
		void refetch();
	}

	const variants = {
		initial: (travel: number) => ({
			opacity: 0,
			x: reducedMotion ? 0 : travel * 34,
		}),
		animate: { opacity: 1, x: 0 },
		exit: (travel: number) => ({
			opacity: 0,
			x: reducedMotion ? 0 : travel * -22,
		}),
	};

	return (
		<div
			data-first-mile {...mergeStylexProps("grid-rows-[76px_minmax(0,1fr)_84px] phone:grid-rows-[68px_minmax(0,1fr)_90px] phone:pb-[env(safe-area-inset-bottom)]", sx.relative, sx.grid, sx.h100dvh, sx.wFull, sx.overflowHidden, sx.bgBg, sx.textFg)}
		>
			<div {...mergeStylexProps("[background:radial-gradient(circle_at_18%_8%,var(--accent-soft),transparent_34%),radial-gradient(circle_at_82%_92%,var(--blue-soft),transparent_36%)]", sx.pointerEventsNone, sx.absolute, sx.inset0, sx.opacity70)}
				aria-hidden="true"
			/>

			<TopBar
				as="header" {...mergeStylexProps("phone:px-4", sx.relative, sx.z10, sx.grid, sx.gridCols1frAuto1fr, sx.px8)}
			>
				<Button
					variant="ghost"
					size="lg"
					icon={<IconChevronLeft size={18} />}
					onClick={() => goTo(index - 1)}
					aria-label="Back"
					{...stylex.props(sx.phoneBackButton, index === 0 && sx.phoneInvisible)}
				/>

				<nav
					{...stylex.props(sx.progressNav, index === 0 && sx.invisible)}
					aria-label="Onboarding progress"
				>
					{STEPS.slice(1).map((item, itemIndex) => {
						const stepIndex = itemIndex + 1;
						return (
							<button
								key={item.id}
								type="button"
								aria-label={item.label}
								aria-current={stepIndex === index ? "step" : undefined}
								onClick={() => goTo(stepIndex)}
								{...stylex.props(
									sx.progressStep,
									stepIndex === index
										? sx.progressCurrent
										: stepIndex < index
											? sx.progressComplete
											: sx.progressUpcoming,
								)}
							/>
						);
					})}
				</nav>

				{index > 0 && index < STEPS.length - 1 ? (
					<button
						type="button"
						onClick={() => goTo(index + 1)} {...mergeStylexProps("hover:bg-hover hover:text-fg", sx.focusRing, sx.colStart3, sx.minH9, sx.justifySelfEnd, sx.roundedControl, sx.px3, sx.fontMedium, sx.textDim, typography.label)}
					>
						Skip
					</button>
				) : (
					<div {...stylex.props(sx.colStart3)} />
				)}
			</TopBar>

			<main
				ref={mainRef} {...mergeStylexProps("phone:px-4", sx.relative, sx.z10, sx.minH0, sx.overflowYAuto, sx.px6, sx.ScrollbarWidthThin)}
			>
				{!status ? (
					<div {...stylex.props(sx.flex, sx.hFull, sx.itemsCenter, sx.justifyCenter)}>
						<LoadingState>
							{failed ? "Couldn't load setup." : "Preparing your workspace…"}
						</LoadingState>
					</div>
				) : (
					<AnimatePresence initial={false} mode="wait" custom={direction}>
						<motion.section
							key={step.id}
							custom={direction}
							variants={variants}
							initial="initial"
							animate="animate"
							exit="exit"
							transition={{
								type: "tween",
								duration: reducedMotion ? duration.micro : duration.large,
								ease,
							}}
							{...stylex.props(sx.stepSection, step.id === "welcome" && sx.welcomeStep)}
						>
							{step.id === "welcome" ? (
								<div {...stylex.props(sx.flex, sx.maxW560px, sx.flexCol, sx.itemsCenter, sx.textCenter)}>
									<img
										src={`${BASE_PATH}/mac-app-icon.png`}
										alt="" {...mergeStylexProps("[filter:drop-shadow(0_18px_28px_rgba(0,0,0,0.16))] phone:mb-6 phone:size-16", sx.mb7, sx.size20, sx.scale113)}
									/>
									<h1
										ref={headingRef} {...mergeStylexProps("text-[clamp(1.6rem,2vw,2.15rem)]", sx.m0, sx.textCenter, sx.fontTitle, sx.leading108, sx.tracking003em, sx.textFg, sx.outlineNone)}
									>
										{step.title}
									</h1>
									<p {...stylex.props(sx.mt3, sx.maxW440px, sx.textPretty, sx.leadingRelaxed, sx.textDim, typography.body)}>
										{step.description}
									</p>
									<div {...stylex.props(sx.mt7, sx.flex, sx.wFull, sx.maxW300px, sx.flexCol, sx.gap3)}>
										<Button
											variant="primary"
											size="lg"
											onClick={() => goTo(1)}
											{...stylex.props(sx.minH11, sx.wFull, sx.justifyCenter)}
										>
											Create organization
										</Button>
										<Button
											variant="soft"
											size="lg"
											onClick={onDone}
											{...stylex.props(sx.minH11, sx.wFull, sx.justifyCenter)}
										>
											Join organization
										</Button>
									</div>
								</div>
							) : (
								<>
									<div {...mergeStylexProps("phone:mb-6", sx.mb8, sx.maxW700px, sx.textCenter)}>
										<h1
											ref={headingRef}
											tabIndex={-1} {...mergeStylexProps("text-[clamp(1.6rem,2.5vw,2.25rem)]", sx.m0, sx.textBalance, sx.fontTitle, sx.leading108, sx.tracking0035em, sx.textFg, sx.outlineNone)}
										>
											{step.title}
										</h1>
										<p {...stylex.props(sx.mt3, sx.textPretty, sx.leadingRelaxed, sx.textDim, typography.body)}>
											{step.description}
										</p>
									</div>

									<div {...mergeStylexProps("[&_.bg-settings-plate]:rounded-2xl [&_.bg-settings-plate]:border-transparent [&_.bg-settings-plate]:bg-blue-soft/65 [&_.bg-settings-plate]:shadow-[inset_0_1px_0_color-mix(in_srgb,white_45%,transparent),0_18px_46px_-36px_color-mix(in_srgb,var(--blue)_48%,transparent)] [&_[data-setting-description]]:hidden [&_[data-settings-hint]]:hidden", sx.wFull, sx.maxW820px, sx.pb8)}>
										{step.id === "github" && (
											<GithubAuthCard
												github={status.github}
												onSaved={setup.applyGithub}
												onboarding
											/>
										)}
										{step.id === "organization" && (
											<OrganizationProfileSection
												githubOrganization={connectedGithubOrganization(status)}
												showDomain={false}
											/>
										)}
										{step.id === "team" && (
											<TeamSection
												onChanged={refetch}
												title="Members"
												showCount
												githubOnly
												compact
											/>
										)}
										{step.id === "ai" && (
											<ProviderAccountsSection onboarding onChanged={refetch} />
										)}
										{step.id === "repos" && (
											<ReposSection repos={status.repos} onChanged={refetch} compact />
										)}
										{step.id === "ready" && (
											<FirstMileSummary
												status={status}
												onSelect={(stepId) =>
													goTo(STEPS.findIndex((item) => item.id === stepId))
												}
											/>
										)}
									</div>
								</>
							)}
						</motion.section>
					</AnimatePresence>
				)}
			</main>

			<footer
				{...stylex.props(
					sx.footer,
					footerSeparated ? sx.footerSeparated : sx.footerAttached,
					index === 0 && sx.invisible,
				)}
			>
				<div {...mergeStylexProps("phone:grid-cols-1 phone:items-start", sx.mxAuto, sx.grid, sx.hFull, sx.wFull, sx.maxW820px, sx.gridCols1frAuto1fr, sx.itemsCenter)}>
					<Button
						variant="ghost"
						size="lg"
						icon={<IconChevronLeft size={18} />}
						onClick={() => goTo(index - 1)}
						{...stylex.props(sx.desktopBackButton, index === 0 && sx.invisible)}
					>
						Back
					</Button>

					<span className="phone:hidden" />

					<Button
						variant="primary"
						size="lg"
						onClick={() => {
							if (index === STEPS.length - 1) onDone();
							else goTo(index + 1);
						}}
						disabled={!status} {...mergeStylexProps("phone:min-h-12 phone:w-full phone:justify-center phone:rounded-lg", sx.justifySelfEnd)}
					>
						{index === 0
							? "Continue"
							: index === STEPS.length - 1
								? `Enter ${PRODUCT_NAME}`
								: index === STEPS.length - 2
									? "Review"
									: "Next"}
					</Button>
				</div>
			</footer>

			<SetupRestart setup={setup} />
		</div>
	);
}
