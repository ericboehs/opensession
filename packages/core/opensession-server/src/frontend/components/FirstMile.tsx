import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, PRODUCT_NAME } from "../lib/brand";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
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
import { IngressPanel } from "./settings/IngressPanel";
import { IconCheck, IconChevronLeft, IconGlobe, IconRepo } from "./icons";
import { githubAuthState, type SetupStatus } from "./setup-shared";

interface FirstMileStep {
	id: "welcome" | "ingress" | "github" | "organization" | "team" | "ai" | "repos" | "ready";
	label: string;
	title: string;
	description: string;
}

// Organization and model setup come first, before the connection steps.
// Domains remains before GitHub so a configured endpoint can prefill the App
// form, but the step stays optional for private-only installations. Members sit
// after repositories, since an invite is worth more once there is something to
// join. The members step is removed when GitHub sign-in is not connected,
// because that step imports and invites people through the connected GitHub
// organization.
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
		id: "ingress",
		label: "Domains",
		title: "Domains",
		description: "Keep the app private for your team. Optionally let external services reach a public callback endpoint.",
	},
	{
		id: "github",
		label: "GitHub",
		title: "Connect GitHub",
		description: "GitHub signs you in and lets sessions access repositories, push changes, and create and review pull requests. The App form includes your public webhook URL.",
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

function githubTeamOnboardingEnabled(status: SetupStatus | null): boolean {
	return Boolean(status?.github.userPrAuth && status.github.clientIdConfigured);
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
				"flex size-7 items-center justify-center rounded-full border text-meta font-semibold text-dim",
				transparent ? "border-transparent bg-transparent" : "border-bg bg-bg/85",
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
	const showTeam = githubTeamOnboardingEnabled(status);
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
				<div className="flex max-w-full items-center gap-1.5 rounded-full bg-bg/65 py-1 pr-2 pl-1 text-meta font-medium text-fg">
					<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg/85 text-dim">
						<IconGlobe size={15} />
					</span>
					<span className="truncate">{serverHost}</span>
				</div>
			),
		},
		{
			title: "GitHub",
			step: "github" as const,
			ready: github.tone === "on",
			label: github.label,
			preview: (
				<div className="flex max-w-full items-center gap-1.5 rounded-full bg-bg/65 py-1 pr-2 pl-1 text-meta font-medium text-fg">
					{githubOrganization ? (
						<span className="relative flex size-6 shrink-0">
							<UserAvatar
								name={githubOrganization}
								login={githubOrganization}
								size={24}
								className="rounded-full"
							/>
							<span className="absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center rounded-full bg-fg text-bg ring-1 ring-bg">
								<BrandMark name="github" size={7} />
							</span>
						</span>
					) : (
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fg text-bg">
							<BrandMark name="github" size={15} />
						</span>
					)}
					<span className="truncate">{githubOrganization || "GitHub"}</span>
				</div>
			),
		},
		{
			title: "AI subscriptions",
			step: "ai" as const,
			ready: status.engine.ready,
			label: `${accountCount} ${accountCount === 1 ? "account" : "accounts"} connected`,
			preview: (
				<div className="flex -space-x-2">
					{accounts.slice(0, 4).map((account, index) => (
						<span
							key={`${account.provider}-${index}`}
							title={account.label}
							className="flex size-7 items-center justify-center rounded-full border border-bg bg-bg/85 text-fg"
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
				<div className="flex -space-x-2">
					{status.repos.slice(0, 4).map((repo) => (
						<span
							key={repo.id}
							title={repo.label}
							className="flex size-7 items-center justify-center rounded-full border border-bg bg-bg/85 text-dim"
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
				<div className="flex -space-x-2">
					{status.team.names.slice(0, 4).map((name) => (
						<UserAvatar key={name} name={name} size={28} className="border border-bg" />
					))}
					<PreviewOverflow count={status.team.names.length - 4} transparent />
				</div>
			),
		},
	].filter((tile) => tile.step !== "team" || showTeam);

	return (
		<div
			className={cn(
				"grid gap-3 phone:grid-cols-2",
				showTeam ? "grid-cols-5" : "mx-auto max-w-[760px] grid-cols-4",
			)}
		>
			{tiles.map((tile) => {
				const className = cn(
					"flex aspect-square min-w-0 flex-col justify-between rounded-2xl border p-4 text-left backdrop-blur-xl phone:rounded-xl phone:p-3.5",
					tile.step &&
						"focus-ring cursor-pointer transition-[transform,filter] duration-150 hover:brightness-[0.98] active:scale-[0.96] motion-reduce:transform-none",
					tile.ready
						? "border-transparent bg-green-soft shadow-[inset_0_1px_0_color-mix(in_srgb,white_45%,transparent),0_12px_28px_-24px_color-mix(in_srgb,var(--green)_45%,transparent)]"
						: "border-divider-soft bg-settings-plate/65",
				);
				const content = (
					<>
						<div className="flex min-w-0 items-start justify-between gap-2">
							<div className="min-w-0">{tile.preview}</div>
							<div
								className={cn(
									"flex size-8 shrink-0 items-center justify-center rounded-full",
									tile.ready ? "bg-green text-white" : "bg-faint/10 text-faint",
								)}
							>
								{tile.ready ? (
									<IconCheck size={18} />
								) : (
									<span className="size-2 rounded-full bg-current" />
								)}
							</div>
						</div>
						<div className="min-w-0">
							<div className="text-item-title font-semibold text-fg">{tile.title}</div>
							<div className="mt-1 text-supporting leading-snug text-dim">{tile.label}</div>
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
	const [index, setIndex] = useState(0);
	const [direction, setDirection] = useState(1);
	const [footerSeparated, setFooterSeparated] = useState(false);
	const [finishing, setFinishing] = useState(false);
	const [ingressReady, setIngressReady] = useState(false);
	const [theme, setTheme] = useState(effectiveTheme);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const mainRef = useRef<HTMLElement>(null);
	const reducedMotion = useReducedMotion();
	const steps = githubTeamOnboardingEnabled(status)
		? STEPS
		: STEPS.filter((item) => item.id !== "team");
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

	async function goTo(next: number) {
		const nextIndex = Math.min(Math.max(next, 0), steps.length - 1);
		if (nextIndex === index) return;
		// The GitHub creation link carries the public callback URL. Refresh it
		// after the preceding ingress step before rendering a clickable link.
		if (steps[nextIndex]?.id === "github") await refetch();
		setDirection(nextIndex > index ? 1 : -1);
		setIndex(nextIndex);
		if (steps[nextIndex]?.id !== "github") void refetch();
	}

	async function finish() {
		if (finishing) return;
		setFinishing(true);
		await onDone();
		setFinishing(false);
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

	const backdropName = theme === "dark" ? "onboarding-bg-dark" : "onboarding-bg";

	return (
		<div
			data-first-mile
			className="relative grid h-[100dvh] w-full grid-rows-[76px_minmax(0,1fr)_84px] overflow-hidden bg-surface bg-cover bg-center text-fg phone:grid-rows-[68px_minmax(0,1fr)_90px] phone:pb-[env(safe-area-inset-bottom)]"
			// The vendored marketing artwork keeps first run independent of a CDN.
			// Painting it on the shell lets a transparent idle footer reveal it.
			style={{ backgroundImage: `url(${BASE_PATH}/${backdropName}.webp)` }}
		>
			<TopBar
				as="header"
				className="relative z-10 grid grid-cols-[1fr_auto_1fr] px-8 phone:px-4"
			>
				<Button
					variant="ghost"
					size="lg"
					icon={<IconChevronLeft size={18} />}
					onClick={() => goTo(index - 1)}
					aria-label="Back"
					className={cn(
						"hidden justify-self-start phone:flex phone:size-10 phone:justify-center phone:p-0",
						index === 0 && "phone:invisible",
					)}
				/>

				<nav
					className={cn(
						"absolute left-1/2 flex -translate-x-1/2 items-center gap-2",
						index === 0 && "invisible",
					)}
					aria-label="Onboarding progress"
				>
					{steps.slice(1).map((item, itemIndex) => {
						const stepIndex = itemIndex + 1;
						return (
							<button
								key={item.id}
								type="button"
								aria-label={item.label}
								aria-current={stepIndex === index ? "step" : undefined}
								onClick={() => goTo(stepIndex)}
								className={cn(
									"focus-ring h-2 cursor-pointer rounded-full transition-[width,background-color] duration-200",
									stepIndex === index
										? "w-8 bg-fg"
										: stepIndex < index
											? "w-2 bg-fg/45"
											: "w-2 bg-faint/35 hover:bg-faint/60",
								)}
							/>
						);
					})}
				</nav>

				{index > 0 && index < steps.length - 1 && step.id !== "ingress" ? (
					<button
						type="button"
						onClick={() => goTo(index + 1)}
						className="focus-ring col-start-3 min-h-9 justify-self-end rounded-control px-3 text-label font-medium text-dim hover:bg-hover hover:text-fg"
					>
						Skip
					</button>
				) : (
					<div className="col-start-3" />
				)}
			</TopBar>

			<main
				ref={mainRef}
				className="relative z-10 min-h-0 overflow-y-auto px-6 [scrollbar-width:thin] phone:px-4"
			>
				{!status ? (
					<div className="flex h-full items-center justify-center">
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
							className={cn(
								"mx-auto flex min-h-full w-full flex-col items-center py-8 phone:py-5",
								step.id === "ingress" ? "max-w-[1120px]" : "max-w-[960px]",
								step.id === "welcome" && "justify-center pb-16 phone:pb-10",
							)}
						>
							{step.id === "welcome" ? (
								<div className="flex max-w-[560px] flex-col items-center text-center">
									<img
										src={`${BASE_PATH}/mac-app-icon.png`}
										alt=""
										className="mb-7 size-20 scale-[1.13] [filter:drop-shadow(0_18px_28px_rgba(0,0,0,0.16))] phone:mb-6 phone:size-16"
									/>
									<h1
										ref={headingRef}
										className="m-0 text-center text-[clamp(1.6rem,2vw,2.15rem)] font-title leading-[1.08] tracking-[-0.03em] text-fg outline-none"
									>
										{step.title}
									</h1>
									<p className="mt-3 max-w-[440px] text-pretty text-body font-normal leading-relaxed text-dim">
										{step.description}
									</p>
									<div className="mt-7 w-full max-w-[300px]">
										<Button
											variant="primary"
											size="lg"
											onClick={() => goTo(1)}
											className="min-h-11 w-full justify-center"
										>
											Setup server
										</Button>
									</div>
								</div>
							) : (
								<>
									<div className="mb-8 max-w-[700px] text-center phone:mb-6">
										<h1
											ref={headingRef}
											tabIndex={-1}
											className="m-0 text-balance text-[clamp(1.6rem,2.5vw,2.25rem)] font-title leading-[1.08] tracking-[-0.035em] text-fg outline-none phone:text-[1.5rem]"
										>
											{step.title}
										</h1>
										<p className="mt-3 text-pretty text-body font-normal leading-relaxed text-dim">
											{step.description}
										</p>
									</div>

									{/* The marketing site places translucent white sections over this same
									    artwork. Keep the app's settings layout, but use that material here. */}
									<div
										className={cn(
											"w-full pb-8 [&_[data-setting-title]]:text-dialog-title [&_[data-setting-title]]:phone:text-body",
											// The split ingress step needs room for setup commands. The final
											// review uses the full canvas for larger tiles; forms stay focused.
											step.id === "ingress"
												? "max-w-[1120px]"
												: step.id === "ready"
													? "max-w-[960px]"
													: "max-w-[820px]",
											// Match opensession.com's card glass: translucent paper, a quiet
											// hairline, and the same 14px blur with restrained saturation.
											"[&_.bg-settings-plate]:rounded-3xl [&_.bg-settings-plate]:border-divider-soft [&_.bg-settings-plate]:bg-[color-mix(in_srgb,var(--popup-surface)_86%,transparent)] [&_.bg-settings-plate]:shadow-[0_18px_46px_-36px_color-mix(in_srgb,var(--blue)_48%,transparent)] [&_.bg-settings-plate]:[backdrop-filter:blur(14px)_saturate(1.08)]",
											// First-run fields use the large field step, with extra room
											// for the fixed-width organization and product names.
											"[&_input]:h-9 [&_input]:min-h-9 [&_input]:px-3 [&_input]:text-base [&_select]:min-h-9 [&_textarea]:min-h-9 [&_input[data-setup-field='identity']]:w-[240px] [&_input[data-setup-field='org-name']]:w-[320px]",
										)}
									>
										{step.id === "ingress" && (
											<IngressPanel
												onboarding
												setup={setup}
												onChanged={refetch}
												onStatusChange={(ingress) => {
													if (ingress.health !== "ready") {
														setIngressReady(false);
														return;
													}
													void refetch().then(() => setIngressReady(true));
												}}
											/>
										)}
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
								</>
							)}
						</motion.section>
					</AnimatePresence>
				)}
			</main>

			<footer
				className={cn(
					"relative z-10 border-t px-8 pt-1 transition-[border-color,background-color] phone:px-5 phone:pt-3",
					footerSeparated
						? "border-line bg-bg/95 backdrop-blur-xl"
						: "border-transparent bg-transparent",
					index === 0 && "invisible",
				)}
			>
				<div className="mx-auto grid h-full w-full max-w-[820px] grid-cols-[1fr_auto_1fr] items-center phone:grid-cols-1 phone:items-start">
					<Button
						variant={footerSeparated ? "ghost" : "overlay"}
						size="lg"
						icon={<IconChevronLeft size={18} />}
						onClick={() => goTo(index - 1)}
						className={cn(
							"justify-self-start phone:hidden",
							!footerSeparated && "text-white!",
							index === 0 && "invisible",
						)}
					>
						Back
					</Button>

					<span className="phone:hidden" />

					<Button
						variant="primary"
						size="lg"
						onClick={() => {
							if (index === steps.length - 1) void finish();
							else goTo(index + 1);
						}}
						disabled={!status || finishing}
						className="justify-self-end phone:min-h-12 phone:w-full phone:justify-center phone:rounded-lg"
					>
						{step.id === "ingress" && !ingressReady
							? "Skip for now"
							: index === 0
							? "Continue"
							: index === steps.length - 1
								? finishing
									? "Finishing…"
									: `Enter ${PRODUCT_NAME}`
								: index === steps.length - 2
									? "Review"
									: "Next"}
					</Button>
				</div>
			</footer>

			<SetupRestart setup={setup} />
		</div>
	);
}
