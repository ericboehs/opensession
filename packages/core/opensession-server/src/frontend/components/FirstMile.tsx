import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, PRODUCT_NAME } from "../lib/brand";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration, ease } from "../ui/motion";
import { LoadingState } from "../ui/state";
import { BrandMark } from "./BrandTile";
import { GithubAuthCard } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { TeamSection } from "./SetupTeam";
import { UserAvatar } from "./UserAvatar";
import { OrganizationProfileSection } from "./settings/GeneralPanel";
import { ProviderAccountsSection } from "./settings/ModelAccounts";
import { IconCheck, IconGlobe, IconRepo } from "./icons";
import { githubAuthState, type SetupStatus } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

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
			gap: "calc(4px * 1.5)"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)",

		cornerShape: "round",},
	py1: {
			paddingBlock: "4px"
	},
	pr2: {
			paddingRight: "calc(4px * 2)"
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
			width: "calc(4px * 6)",
			height: "calc(4px * 6)"
	},
	shrink0: {
			flexShrink: "0"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	truncate: {
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
	},
	relative: {
			position: "relative"
	},
	absolute: {
			position: "absolute"
	},
	Right05: {
			right: "calc(4px * -0.5)"
	},
	Bottom05: {
			bottom: "calc(4px * -0.5)"
	},
	size25: {
			width: "calc(4px * 2.5)",
			height: "calc(4px * 2.5)"
	},
	textBg: {
			color: "var(--bg)"
	},
	size7: {
			width: "calc(4px * 7)",
			height: "calc(4px * 7)"
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
	gap4: {
			gap: "calc(4px * 4)"
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
			gap: "calc(4px * 2)"
	},
	size2: {
			width: "calc(4px * 2)",
			height: "calc(4px * 2)"
	},
	bgCurrent: {
			backgroundColor: "currentcolor"
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
	gapY3: {
			rowGap: "calc(4px * 3)"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	bgCover: {
			backgroundSize: "cover"
	},
	bgCenter: {
			backgroundPosition: "center"
	},
	p6: {
			padding: "calc(4px * 6)"
	},
	z20: {
			zIndex: "20"
	},
	h11: {
			height: "calc(4px * 11)"
	},
	h10: {
			height: "calc(4px * 10)"
	},
	w8: {
			width: "calc(4px * 8)"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))",

		cornerShape: "var(--cs)",},
	minH40: {
			minHeight: "calc(4px * 40)"
	},
	maxW560px: {
			maxWidth: "560px"
	},
	justifySelfCenter: {
			justifySelf: "center"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))",

		cornerShape: "var(--cs)",},
	bgPaletteGlass: {
			backgroundColor: "var(--palette-glass)"
	},
	px8: {
			paddingInline: "calc(4px * 8)"
	},
	py12: {
			paddingBlock: "calc(4px * 12)"
	},
	BackdropFilterVarPopupBlur: {
			backdropFilter: "var(--popup-blur)"
	},
	px10: {
			paddingInline: "calc(4px * 10)"
	},
	pb2: {
			paddingBottom: "calc(4px * 2)"
	},
	pt9: {
			paddingTop: "calc(4px * 9)"
	},
	textCenter: {
			textAlign: "center"
	},
	mxAuto: {
			marginInline: "auto"
	},
	mb7: {
			marginBottom: "calc(4px * 7)"
	},
	size16: {
			width: "calc(4px * 16)",
			height: "calc(4px * 16)"
	},
	textBalance: {
			textWrap: "balance"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	leading11: {
			lineHeight: "1.1"
	},
	tracking0012em: {
			letterSpacing: "-0.012em"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	px4: {
			paddingInline: "calc(4px * 4)"
	},
});

interface FirstMileStep {
	id: "welcome" | "github" | "organization" | "team" | "ai" | "repos" | "ready";
	label: string;
	title: string;
	description: string;
}

// Organization and model setup come first. GitHub App creation no longer
// depends on a public callback origin: the manifest returns its credentials to
// the private app, while Domains and public callbacks stay in Settings. Members
// sit after repositories, since an identity is worth more once there is something
// to act on. Members remain independent from the optional GitHub sign-in gate.
const STEPS: FirstMileStep[] = [
	{
		id: "welcome",
		label: "Welcome",
		title: `Welcome to ${PRODUCT_NAME}`,
		description: "Set up this server before you start using Open Session.",
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
		id: "github",
		label: "GitHub",
		title: "Connect GitHub",
		description: "Connect a GitHub App so sessions can access repositories, push changes, and create and review pull requests.",
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
		title: "Team members",
		description: "Add yourself and anyone else sessions can act as. GitHub usernames are optional.",
	},
	{
		id: "ready",
		label: "Ready",
		title: "You’re ready",
		description: "Review your setup before entering Open Session.",
	},
];

function githubOrganizationImportEnabled(status: SetupStatus | null): boolean {
	return Boolean(
		status?.github.userPrAuth &&
			status.github.clientIdConfigured &&
			status.github.appOrg,
	);
}

function initialFirstMileIndex(): number {
	if (typeof window === "undefined") return 0;
	const stored = window.sessionStorage.getItem("opensession:first-mile-step");
	window.sessionStorage.removeItem("opensession:first-mile-step");
	const requested =
		new URLSearchParams(window.location.search).get("step") || stored;
	if (!requested) return 0;
	const index = STEPS.findIndex((item) => item.id === requested);
	return index < 0 ? 0 : index;
}

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
			className={cn(
				utilityClassName("flex size-7 items-center justify-center rounded-full border text-meta font-semibold text-dim"),
				transparent ? utilityClassName("border-transparent bg-transparent") : utilityClassName("border-bg bg-bg/85"),
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
				<div {...mergeStylexProps("bg-bg/65", sx.flex, sx.maxWFull, sx.itemsCenter, sx.gap15, sx.roundedFull, sx.py1, sx.pr2, sx.pl1, sx.fontMedium, sx.textFg, typography.meta)} >
					<span {...mergeStylexProps("bg-bg/85", sx.flex, sx.size6, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.textDim)} >
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
				<div {...mergeStylexProps("bg-bg/65", sx.flex, sx.maxWFull, sx.itemsCenter, sx.gap15, sx.roundedFull, sx.py1, sx.pr2, sx.pl1, sx.fontMedium, sx.textFg, typography.meta)} >
					{githubOrganization ? (
						<span {...stylex.props(sx.relative, sx.flex, sx.size6, sx.shrink0)}>
							<UserAvatar
								name={githubOrganization}
								login={githubOrganization}
								size={24}
								className={mergeStylexOverrideClassName("", sx.roundedFull)}
							/>
							<span {...mergeStylexProps("bg-fg ring-1 ring-bg", sx.absolute, sx.Right05, sx.Bottom05, sx.flex, sx.size25, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.textBg)} >
								<BrandMark name="github" size={7} />
							</span>
						</span>
					) : (
						<span {...mergeStylexProps("bg-fg", sx.flex, sx.size6, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.textBg)} >
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
				<div {...mergeStylexProps("-space-x-2", sx.flex)} >
					{accounts.slice(0, 4).map((account, index) => (
						<span
							key={`${account.provider}-${index}`}
							title={account.label}
							{...mergeStylexProps("bg-bg/85", sx.flex, sx.size7, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderBg, sx.textFg)}
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
				<div {...mergeStylexProps("-space-x-2", sx.flex)} >
					{status.repos.slice(0, 4).map((repo) => (
						<span
							key={repo.id}
							title={repo.label}
							{...mergeStylexProps("bg-bg/85", sx.flex, sx.size7, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.border, sx.borderBg, sx.textDim)}
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
				<div {...mergeStylexProps("-space-x-2", sx.flex)} >
					{status.team.names.slice(0, 4).map((name) => (
						<UserAvatar key={name} name={name} size={28} className={mergeStylexOverrideClassName("", sx.border, sx.borderBg)} />
					))}
					<PreviewOverflow count={status.team.names.length - 4} transparent />
				</div>
			),
		},
	];

	return (
		<div {...mergeStylexProps("desktop:grid-cols-[repeat(auto-fit,200px)] phone:grid-cols-2 phone:gap-3", sx.grid, sx.justifyCenter, sx.gap4)} >
			{tiles.map((tile) => {
				const className = cn(
					utilityClassName("flex aspect-square min-w-0 flex-col justify-between rounded-2xl bg-palette-glass p-5 text-left [backdrop-filter:var(--popup-blur)] smooth-shadow-sm desktop:size-[200px] phone:p-3.5"),
					tile.step &&
						utilityClassName("focus-ring cursor-pointer transition-[transform,filter] duration-150 hover:brightness-[0.98] active:scale-[0.96] motion-reduce:transform-none"),
				);
				const content = (
					<>
						<div {...stylex.props(sx.flex, sx.minW0, sx.itemsStart, sx.justifyBetween, sx.gap2)}>
							<div {...stylex.props(sx.minW0)}>{tile.preview}</div>
							<div
								className={cn(
									utilityClassName("flex size-8 shrink-0 items-center justify-center rounded-full"),
									tile.ready ? utilityClassName("bg-green text-white") : utilityClassName("bg-faint/10 text-faint"),
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
						className={className}
					>
						{content}
					</button>
				) : (
					<div key={tile.title} className={className}>
						{content}
					</div>
				);
			})}
		</div>
	);
}

export function FirstMile({ onDone }: { onDone: () => Promise<void> }) {
	const setup = useSetupStatus();
	const { status, failed, refetch } = setup;
	const [index, setIndex] = useState(initialFirstMileIndex);
	const [contentVisible, setContentVisible] = useState(true);
	const [navigationVisible, setNavigationVisible] = useState(true);
	const [finishing, setFinishing] = useState(false);
	const [theme, setTheme] = useState(effectiveTheme);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const reducedMotion = useReducedMotion();
	const steps = STEPS;
	const step = steps[index]!;

	useEffect(() => {
		document.title = `Welcome to ${PRODUCT_NAME}`;
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, []);

	useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);

	useEffect(() => {
		if (index > 0) headingRef.current?.focus({ preventScroll: true });
	}, [index]);

	// `onLayoutAnimationComplete` is the exact reveal signal. This timeout is a
	// fallback for steps whose measured modal geometry happens to be identical,
	// in which case Motion has no layout animation to complete.
	useEffect(() => {
		if (contentVisible) return;
		const reveal = window.setTimeout(() => {
			setContentVisible(true);
			setNavigationVisible(true);
		}, (reducedMotion ? duration.micro : duration.large) * 1000);
		return () => window.clearTimeout(reveal);
	}, [contentVisible, index, reducedMotion]);

	async function goTo(next: number) {
		const nextIndex = Math.min(Math.max(next, 0), steps.length - 1);
		if (nextIndex === index) return;
		setContentVisible(false);
		setNavigationVisible(false);
		setIndex(nextIndex);
		void refetch();
	}

	async function finish() {
		if (finishing) return;
		setNavigationVisible(false);
		setFinishing(true);
		await onDone();
		setFinishing(false);
		setNavigationVisible(true);
	}

	const backdropName =
		theme === "dark" ? "onboarding-bg-dark" : "onboarding-bg";
	const nextLabel =
		index === 0
			? "Setup server"
			: index === steps.length - 1
				? finishing
					? "Finishing…"
					: null
				: index === steps.length - 2
					? "Review"
					: "Next";

	return (
		<div
			data-first-mile
			{...mergeStylexProps("grid-rows-[44px_minmax(0,1fr)] phone:gap-y-0 phone:px-0 phone:pb-0 phone:pt-[max(12px,env(safe-area-inset-top))]", sx.relative, sx.grid, sx.h100dvh, sx.wFull, sx.gapY3, sx.overflowHidden, sx.bgSurface, sx.bgCover, sx.bgCenter, sx.p6, sx.textFg)}
			// The vendored marketing artwork keeps first run independent of a CDN.
			style={{ backgroundImage: `url(${BASE_PATH}/${backdropName}.webp)` }}
		>
			<nav
				aria-label="Onboarding progress"
				{...stylex.props(sx.relative, sx.z20, sx.flex, sx.h11, sx.shrink0, sx.itemsStart, sx.justifyCenter)}
			>
				{steps.map((item, stepIndex) => (
					<button
						key={item.id}
						type="button"
						onClick={() => goTo(stepIndex)}
						aria-label={`${item.label}, step ${stepIndex + 1} of ${steps.length}`}
						aria-current={stepIndex === index ? "step" : undefined}
						{...mergeStylexProps("group focus-ring phone:h-11 phone:w-9", sx.flex, sx.h10, sx.w8, sx.itemsCenter, sx.justifyCenter, sx.roundedControl)}
					>
						<span
							aria-hidden="true"
							className={cn(
								utilityClassName("h-2 rounded-full transition-[width,background-color,opacity] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none"),
								stepIndex === index
									? utilityClassName("w-6 bg-fg")
									: stepIndex < index
										? utilityClassName("w-2 bg-fg/45 group-hover:bg-fg/65")
										: utilityClassName("w-2 bg-faint/35 group-hover:bg-faint/60"),
							)}
						/>
					</button>
				))}
			</nav>

			{!status ? (
				<div {...mergeStylexProps("self-center [--smooth-ring-color:var(--dialog-ring)] smooth-shadow-ring-lg", sx.flex, sx.minH40, sx.wFull, sx.maxW560px, sx.justifySelfCenter, sx.itemsCenter, sx.justifyCenter, sx.rounded2xl, sx.bgPaletteGlass, sx.px8, sx.py12, sx.BackdropFilterVarPopupBlur)} >
					<LoadingState>
						{failed ? "Couldn't load setup." : "Preparing your workspace…"}
					</LoadingState>
				</div>
			) : (
				<motion.section
					layout
					onLayoutAnimationComplete={() => {
						setContentVisible(true);
						setNavigationVisible(true);
					}}
					transition={{
						layout: {
							type: "spring",
							duration: reducedMotion ? duration.micro : duration.large,
							bounce: 0,
						},
					}}
					className={cn(
						utilityClassName("relative z-10 flex max-h-full w-full self-center justify-self-center flex-col overflow-hidden rounded-2xl phone:h-full phone:max-h-none phone:max-w-none phone:self-stretch phone:rounded-none phone:[box-shadow:none]"),
						step.id === "welcome" || step.id === "ready"
							? cn(
									step.id === "ready" ? "max-w-[1144px]" : "max-w-[560px]",
									utilityClassName("bg-transparent [backdrop-filter:none]"),
								)
							: utilityClassName("max-w-[750px] bg-palette-glass [--smooth-ring-color:var(--dialog-ring)] [backdrop-filter:var(--popup-blur)] smooth-shadow-ring-lg"),
					)}
				>
					<div
						key={step.id}
						aria-hidden={!contentVisible}
						inert={!contentVisible}
						className={cn(
							utilityClassName("flex min-h-0 flex-col"),
							!contentVisible && utilityClassName("invisible"),
						)}
					>
						<header {...mergeStylexProps("phone:px-5 phone:pt-6", sx.shrink0, sx.px10, sx.pb2, sx.pt9, sx.textCenter)} >
							{step.id === "welcome" && (
								<img
									src={`${BASE_PATH}/mac-app-icon.png`}
									alt=""
									{...mergeStylexProps("[filter:drop-shadow(0_18px_28px_rgba(0,0,0,0.16))] phone:mb-6", sx.mxAuto, sx.mb7, sx.size16)}
								/>
							)}
							<h1
								ref={headingRef}
								tabIndex={index > 0 ? -1 : undefined}
								{...mergeStylexProps("m-0 phone:text-section-title", sx.textBalance, sx.fontTitle, sx.leading11, sx.tracking0012em, sx.textFg, sx.outlineNone, typography.pageTitle)}
							>
								{step.title}
							</h1>
						</header>

						<div
							className={cn(
								utilityClassName("min-h-0"),
								step.id === "welcome"
									? utilityClassName("h-4 shrink-0")
									: utilityClassName("overflow-y-auto overscroll-contain px-10 pb-12 pt-5 [-webkit-mask-image:linear-gradient(to_bottom,#000_0,#000_calc(100%_-_36px),transparent_100%)] [mask-image:linear-gradient(to_bottom,#000_0,#000_calc(100%_-_36px),transparent_100%)] [scrollbar-width:thin] phone:px-4 phone:pb-12 phone:pt-4"),
							)}
						>
							{step.id !== "welcome" && (
								<div
									className={cn(
										utilityClassName("mx-auto w-full [&_[data-setting-title]]:text-dialog-title [&_[data-setting-title]]:phone:text-body [&_[data-settings-group-label]]:text-body [&_[data-settings-group-label]]:text-fg [&_[data-settings-hint]]:leading-[1.5] [&_[data-settings-hint]]:text-faint [&_[data-onboarding-caption]]:leading-[1.5]"),
										step.id === "ready" ? utilityClassName("max-w-[1160px]") : utilityClassName("max-w-[780px]"),
										"[&_.bg-settings-plate]:border-0 [&_.bg-settings-plate]:bg-transparent! [&_.bg-settings-plate]:shadow-none [&_.bg-settings-plate]:[backdrop-filter:none]",
										"[&_input]:h-9 [&_input]:min-h-9 [&_input]:px-3 [&_input]:text-base [&_select]:min-h-9 [&_textarea]:min-h-9",
									)}
								>
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
											onboarding
										/>
									)}
									{step.id === "team" && (
										<TeamSection
											onChanged={refetch}
											title="Members"
											showCount
											onboarding
											syncGithubOrganization={githubOrganizationImportEnabled(status)}
											compact
										/>
									)}
									{step.id === "ai" && (
										<ProviderAccountsSection onboarding onChanged={refetch} />
									)}
									{step.id === "repos" && (
										<ReposSection
											repos={status.repos}
											onChanged={refetch}
											compact
											showLifecycleStatus={false}
										/>
									)}
									{step.id === "ready" && (
										<FirstMileSummary
											status={status}
											onSelect={(stepId) =>
												goTo(steps.findIndex((item) => item.id === stepId))
											}
										/>
									)}
								</div>
							)}
						</div>
					</div>

					<motion.footer
						layout="position"
						initial={false}
						animate={{ opacity: navigationVisible ? 1 : 0 }}
						transition={{ type: "tween", duration: duration.micro, ease }}
						aria-hidden={!navigationVisible}
						inert={!navigationVisible}
						className={cn(
							utilityClassName("relative z-20 shrink-0 px-6 py-4 phone:px-3 phone:pb-[max(12px,env(safe-area-inset-bottom))] phone:pt-3"),
							!navigationVisible && utilityClassName("pointer-events-none"),
						)}
					>
						<div
							className={cn(
								utilityClassName("flex items-center gap-3"),
								index === 0 || step.id === "ready"
									? utilityClassName("justify-center")
									: utilityClassName("justify-between"),
							)}
						>
							{index > 0 && step.id !== "ready" && (
								<Button
									variant="soft"
									size="lg"
									onClick={() => goTo(index - 1)}
									className={utilityClassName("phone:min-h-11")}
								>
									Back
								</Button>
							)}

							<Button
								variant="primary"
								size="lg"
								onClick={() => {
									if (index === steps.length - 1) void finish();
									else goTo(index + 1);
								}}
								disabled={finishing}
								className={mergeStylexOverrideClassName("phone:min-h-11", sx.px4)}
							>
								{nextLabel ?? (
									<>
										<span className={utilityClassName("phone:hidden")}>Enter {PRODUCT_NAME}</span>
										<span className={utilityClassName("desktop:hidden")}>Enter</span>
									</>
								)}
							</Button>
						</div>
					</motion.footer>
				</motion.section>
			)}

			<SetupRestart setup={setup} />
		</div>
	);
}
