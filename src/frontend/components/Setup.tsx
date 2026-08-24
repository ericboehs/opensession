import React, { useEffect, useState } from "react";
import { useSetupStatus } from "../hooks/useSetupStatus";
import { DEFAULT_DOC_TITLE, docTitle } from "../lib/brand";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
	SettingCard,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
} from "../ui/settings";
import { LoadingState } from "../ui/state";
import { EngineRow, SetupChecklist } from "./SetupChecklist";
import { IdentityCard } from "./SetupIdentity";
import { GithubAuthCard, IntegrationsList } from "./SetupIntegrations";
import { ReposSection } from "./SetupRepos";
import { SetupRestart } from "./SetupRestart";
import { TeamSection } from "./SetupTeam";
import {
	chipDotColor,
	githubAuthState,
	integrationState,
	type ChipTone,
	type SetupStatus,
	type SetupStepId,
} from "./setup-shared";

// Settings → Setup: bringing a fresh instance up, one step at a time. On a
// first run nothing else in the UI says what an instance needs — an engine
// that can run a turn, repos to work in, the people it acts for, and the
// credentials for anything it should reach — so this walks through them in
// that order and ends on a review of what's still missing.
//
// Every step is also a Workspace settings page of its own (Identity,
// Repositories, Members, Integrations), rendered from these same components:
// the wizard is for the first hour, the pages are for the next year. Nothing
// here is a second implementation of a setting — a step is a heading, a
// sentence, and the same section the settings page shows.

interface StepDef {
	id: SetupStepId;
	/** Short label for the step rail. */
	label: string;
	title: string;
	description: React.ReactNode;
}

const STEPS: StepDef[] = [
	{
		id: "engine",
		label: "Engine",
		title: "Engine",
		description: "Connect the model capacity that sessions use for every turn.",
	},
	{
		id: "identity",
		label: "Identity",
		title: "Identity",
		description: "Choose the names this instance and its agent use when they introduce themselves.",
	},
	{
		id: "repos",
		label: "Repositories",
		title: "Repositories",
		description: "Register the repositories sessions can work in.",
	},
	{
		id: "team",
		label: "Members",
		title: "Members",
		description: "Add everyone who uses this instance so sessions, commits, and access grants name the right person.",
	},
	{
		id: "integrations",
		label: "Integrations",
		title: "Integrations",
		description: "Connect the tools and event sources your agent should use.",
	},
	{
		id: "github",
		label: "GitHub sign-in",
		title: "GitHub sign-in",
		description:
			"Let teammates sign in with GitHub and open PRs as themselves instead of as the bot account.",
	},
	{
		id: "review",
		label: "Review",
		title: "Review",
		description: "Check what is required for a first session and which team workflows are optional.",
	},
];

/** A step's state for the rail, or null when the step has nothing to report
 *  (identity always has a value; review is a summary of the others). */
function stepTone(id: SetupStepId, status: SetupStatus): ChipTone | null {
	switch (id) {
		case "engine":
			return status.engine.ready ? "on" : "warn";
		case "repos":
			return status.repos.length > 0 ? "on" : "warn";
		case "team":
			return status.team.count > 0 ? "on" : "warn";
		case "github":
			return githubAuthState(status.github).tone;
		case "integrations": {
			const tones = status.integrations.map((i) => integrationState(i).tone);
			if (tones.some((t) => t === "warn")) return "warn";
			return tones.some((t) => t === "on") ? "on" : "off";
		}
		default:
			return null;
	}
}

/** The step rail: every step, its state, and a way straight to it. It doubles
 *  as the progress indicator — a wizard that hides where you are in it is
 *  just a form with extra clicks. */
function StepRail({
	current,
	status,
	onSelect,
}: {
	current: number;
	status: SetupStatus;
	onSelect: (index: number) => void;
}) {
	return (
		<nav aria-label="Setup steps" className="mb-5 flex flex-wrap gap-1 px-5">
			{STEPS.map((step, i) => {
				const tone = stepTone(step.id, status);
				const active = i === current;
				return (
					<button
						key={step.id}
						type="button"
						aria-current={active ? "step" : undefined}
						onClick={() => onSelect(i)}
						className={cn(
							"focus-ring flex items-center gap-1.5 rounded-control px-2 py-1 text-label transition-colors",
							active
								? "bg-active font-medium text-fg"
								: "text-dim hover:bg-hover hover:text-fg",
						)}
					>
						<span
							className={cn(
								"h-1.5 w-1.5 shrink-0 rounded-full",
								!tone && "border border-current opacity-40",
							)}
							style={tone ? { background: chipDotColor(tone) } : undefined}
						/>
						{step.label}
					</button>
				);
			})}
		</nav>
	);
}

export function SetupPanel({ onDone }: { onDone?: () => void }) {
	const setup = useSetupStatus();
	const { status, failed, refetch } = setup;
	const [index, setIndex] = useState(0);

	useEffect(() => {
		document.title = docTitle("Setup");
		return () => {
			document.title = DEFAULT_DOC_TITLE;
		};
	}, []);

	const step = STEPS[index]!;
	const last = index === STEPS.length - 1;

	function goTo(next: number) {
		setIndex(Math.min(Math.max(next, 0), STEPS.length - 1));
		// A step change is a page change: start it at the top, the way the
		// settings pages these steps mirror open.
		document
			.querySelector("[data-settings-scroll]")
			?.scrollTo({ top: 0, behavior: "smooth" });
	}

	function jumpTo(id: SetupStepId) {
		const i = STEPS.findIndex((s) => s.id === id);
		if (i >= 0) goTo(i);
	}

	return (
		<SettingsPanel className="relative">
			<SettingsHeader title="Workspace setup" />
			{!status ? (
				<LoadingState>
					{failed ? "Couldn't load setup status." : "Loading…"}
				</LoadingState>
			) : (
				<>
					<StepRail current={index} status={status} onSelect={goTo} />

					<div className="px-5">
						<h2 className="m-0 text-section-title font-title text-fg">
							{step.title}
						</h2>
						<p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
							{step.description}
						</p>
					</div>

					<div className="mt-4">
						{step.id === "engine" && (
							<>
								<SettingCard>
									<EngineRow engine={status.engine} onChanged={refetch} />
								</SettingCard>
								<SettingsHint>
									Which models are available, and which one sessions start on,
									live under Workspace → Models. Accounts you sign into
									yourself are under Personal → My accounts.
								</SettingsHint>
							</>
						)}
						{step.id === "identity" && <IdentityCard />}
						{step.id === "repos" && (
							<ReposSection
								repos={status.repos}
								onChanged={refetch}
								onRepoUpdated={setup.applyRepo}
							/>
						)}
						{step.id === "team" && <TeamSection onChanged={refetch} />}
						{step.id === "integrations" && (
							<IntegrationsList
								integrations={status.integrations}
								publicBaseUrl={status.publicBaseUrl}
								onSaved={setup.applyIntegration}
							/>
						)}
						{step.id === "github" && (
							<>
								<GithubAuthCard
									github={status.github}
									onSaved={setup.applyGithub}
								/>
								<SettingsHint>
									After setup, teammates connect their own accounts under Personal →
									My accounts.
								</SettingsHint>
							</>
						)}
						{step.id === "review" && (
							<SetupChecklist
								status={status}
								onChanged={refetch}
								onJump={jumpTo}
							/>
						)}
					</div>

					<div className="mt-8 flex items-center gap-3 px-5">
						<Button
							variant="ghost"
							onClick={() => goTo(index - 1)}
							disabled={index === 0}
						>
							Back
						</Button>
						<span className="flex-1 text-center text-meta tabular-nums text-faint">
							Step {index + 1} of {STEPS.length}
						</span>
						{last ? (
							<Button variant="primary" onClick={onDone} disabled={!onDone}>
								Back to app
							</Button>
						) : (
							<Button variant="primary" onClick={() => goTo(index + 1)}>
								Next
							</Button>
						)}
					</div>
				</>
			)}
			<SetupRestart setup={setup} />
		</SettingsPanel>
	);
}
