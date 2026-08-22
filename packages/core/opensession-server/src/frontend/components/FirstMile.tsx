import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { DEFAULT_DOC_TITLE, PRODUCT_NAME } from "../lib/brand";
import { useSetupStatus } from "../hooks/useSetupStatus";
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
import { IconCheck, IconChevronLeft, IconRepo } from "./icons";
import { githubAuthState, type SetupStatus } from "./setup-shared";

interface FirstMileStep {
	id: "welcome" | "github" | "organization" | "team" | "ai" | "repos" | "ready";
	label: string;
	title: string;
}

const STEPS: FirstMileStep[] = [
	{ id: "welcome", label: "Organization", title: `Welcome to ${PRODUCT_NAME}` },
	{ id: "github", label: "GitHub", title: "Connect GitHub" },
	{ id: "organization", label: "Organization", title: "Organization" },
	{ id: "ai", label: "AI", title: "AI subscriptions" },
	{ id: "repos", label: "Repositories", title: "Repositories" },
	{ id: "team", label: "People", title: "Add team members" },
	{ id: "ready", label: "Ready", title: "You’re ready" },
];

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

function FirstMileSummary({ status }: { status: SetupStatus }) {
	const github = githubAuthState(status.github);
	let githubOrganization = status.github.appOrg || "";
	if (!githubOrganization) {
		try {
			const match = new URL(status.github.appCreateUrl).pathname.match(/^\/organizations\/([^/]+)/);
			githubOrganization = match?.[1] ? decodeURIComponent(match[1]) : "";
		} catch {}
	}
	const accountCount = status.engine.claudeAccounts + status.engine.codexAccounts;
	const accounts = [
		...Array.from({ length: status.engine.claudeAccounts }, (_, index) => ({
			name: `Claude account ${index + 1}`,
			provider: "claude" as const,
		})),
		...Array.from({ length: status.engine.codexAccounts }, (_, index) => ({
			name: `Codex account ${index + 1}`,
			provider: "codex" as const,
		})),
	];
	const tiles = [
		{
			title: "GitHub",
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
			ready: status.engine.ready,
			label: `${accountCount} ${accountCount === 1 ? "account" : "accounts"} connected`,
			preview: (
				<div className="flex -space-x-2">
					{accounts.slice(0, 4).map((account, index) => (
						<span
							key={`${account.provider}-${account.name}-${index}`}
							title={account.name}
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
	];

	return (
		<div className="grid grid-cols-4 gap-3 phone:grid-cols-2">
			{tiles.map((tile) => (
				<div
					key={tile.title}
					className={cn(
						"flex aspect-square min-w-0 flex-col justify-between rounded-2xl border p-4 backdrop-blur-xl phone:rounded-xl phone:p-3.5",
						tile.ready
							? "border-transparent bg-green-soft shadow-[inset_0_1px_0_color-mix(in_srgb,white_45%,transparent),0_12px_28px_-24px_color-mix(in_srgb,var(--green)_45%,transparent)]"
							: "border-divider-soft bg-settings-plate/65",
					)}
				>
					<div className="flex min-w-0 items-start justify-between gap-2">
						<div className="min-w-0">{tile.preview}</div>
						<div
							className={cn(
								"flex size-8 shrink-0 items-center justify-center rounded-full",
								tile.ready ? "bg-bg/60 text-green" : "bg-faint/10 text-faint",
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
				</div>
			))}
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
			data-first-mile
			className="relative grid h-[100dvh] w-full grid-rows-[76px_minmax(0,1fr)_84px] overflow-hidden bg-bg text-fg phone:grid-rows-[68px_minmax(0,1fr)_90px] phone:pb-[env(safe-area-inset-bottom)]"
		>
			<div
				className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_18%_8%,var(--accent-soft),transparent_34%),radial-gradient(circle_at_82%_92%,var(--blue-soft),transparent_36%)]"
				aria-hidden="true"
			/>

			<header className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-center px-8 phone:px-4">
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
					{STEPS.slice(1).map((item, itemIndex) => {
						const stepIndex = itemIndex + 1;
						return (
							<button
								key={item.id}
								type="button"
								aria-label={`${itemIndex + 1}. ${item.label}`}
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

				{index > 0 && index < STEPS.length - 1 ? (
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
			</header>

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
								"mx-auto flex min-h-full w-full max-w-[960px] flex-col items-center py-8 phone:py-5",
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
									<div className="mt-7 flex w-full max-w-[300px] flex-col gap-3">
										<Button
											variant="primary"
											size="lg"
											onClick={() => goTo(1)}
											className="min-h-11 w-full justify-center"
										>
											Create organization
										</Button>
										<Button
											variant="soft"
											size="lg"
											onClick={onDone}
											className="min-h-11 w-full justify-center"
										>
											Join organization
										</Button>
									</div>
								</div>
							) : (
								<>
									<div className="mb-8 max-w-[700px] text-center phone:mb-6">
										<h1
											ref={headingRef}
											tabIndex={-1}
											className="m-0 text-[clamp(1.6rem,2.5vw,2.25rem)] font-title leading-[1.08] tracking-[-0.035em] text-fg outline-none"
										>
											{step.title}
										</h1>
									</div>

									{/* Most steps keep the blue glass wash. GitHub is denser and uses
									    neutral settings plates so its guide and form stay quieter. */}
									<div
										className={cn(
											"w-full max-w-[820px] pb-8 [&_[data-setting-description]]:hidden [&_[data-settings-hint]]:hidden",
											step.id !== "github" &&
												"[&_.bg-settings-plate]:bg-blue-soft [&_.bg-settings-plate]:shadow-[inset_0_1px_0_color-mix(in_srgb,white_45%,transparent),0_12px_32px_-24px_color-mix(in_srgb,var(--blue)_45%,transparent)] [&_.bg-settings-plate]:backdrop-blur-xl [&_.border-divider-soft]:border-blue/15 phone:[&_.bg-settings-plate]:bg-[color-mix(in_srgb,var(--blue-soft)_60%,transparent)] phone:[&_.border-divider-soft]:border-blue/10",
										)}
									>
										{step.id === "github" && (
											<GithubAuthCard
												github={status.github}
												onSaved={setup.applyGithub}
												onboarding
											/>
										)}
										{step.id === "organization" && <OrganizationProfileSection />}
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
										{step.id === "ready" && <FirstMileSummary status={status} />}
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
						: "border-transparent bg-[linear-gradient(to_bottom,transparent,var(--bg)_30%)]",
					index === 0 && "invisible",
				)}
			>
				<div className="mx-auto grid h-full w-full max-w-[820px] grid-cols-[1fr_auto_1fr] items-center phone:grid-cols-1 phone:items-start">
					<Button
						variant="ghost"
						size="lg"
						icon={<IconChevronLeft size={18} />}
						onClick={() => goTo(index - 1)}
						className={cn("justify-self-start phone:hidden", index === 0 && "invisible")}
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
						disabled={!status}
						className="justify-self-end phone:min-h-12 phone:w-full phone:justify-center phone:rounded-lg"
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
