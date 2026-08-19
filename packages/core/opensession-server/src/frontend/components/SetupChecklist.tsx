import React, { useState } from "react";
import { Button } from "../ui/button";
import { SettingCard, SettingRow, SettingRowDescription, SettingRowText, SettingRowTitle } from "../ui/settings";
import { toast } from "../ui/toast";
import {
	StateChip,
	githubAuthState,
	integrationState,
	repoLifecycleState,
	setupRequest,
	type ChipTone,
	type SetupEngine,
	type SetupStatus,
	type SetupStepId,
} from "./setup-shared";

// The state of the instance in one card: what runs, what's missing, and — on
// the Setup wizard's last step — a way back to the step that fixes it.

/** One row of the checklist: title, one-liner, state chip. */
function ChecklistRow({
	title,
	description,
	tone,
	label,
	action,
}: {
	title: React.ReactNode;
	description: React.ReactNode;
	tone: ChipTone;
	label: string;
	/** Optional inline fix — only for problems this page can actually solve. */
	action?: React.ReactNode;
}) {
	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>{title}</SettingRowTitle>
				<SettingRowDescription>{description}</SettingRowDescription>
			</SettingRowText>
			{action}
			<StateChip tone={tone} label={label} />
		</SettingRow>
	);
}

/** Checklist row for model capacity. Everything else here is optional;
 *  without this, no session runs a single turn. */
export function EngineRow({
	engine,
	onChanged,
}: {
	engine: SetupEngine;
	onChanged: () => void | Promise<void>;
}) {
	const [enabling, setEnabling] = useState(false);

	async function enable() {
		setEnabling(true);
		try {
			await setupRequest("/api/settings/opencode-engine", {
				method: "PUT",
				json: { enabled: true },
			});
			await onChanged();
			toast("Engine enabled");
		} catch (e: any) {
			toast(e?.message || "Couldn't enable the engine");
		} finally {
			setEnabling(false);
		}
	}

	const pool =
		engine.claudeAccounts + engine.codexAccounts === 0
			? "no accounts"
			: [
					engine.claudeAccounts && `${engine.claudeAccounts} Claude`,
					engine.codexAccounts && `${engine.codexAccounts} ChatGPT`,
				]
					.filter(Boolean)
					.join(", ");

	return (
		<ChecklistRow
			title="Engine"
			description={
				engine.ready
					? `Ready to run turns on ${engine.defaultModel} (${pool}).`
					: `${engine.blocker} ${engine.fix}`
			}
			tone={engine.ready ? "on" : "warn"}
			label={engine.ready ? "Ready" : "Can't run turns"}
			action={
				!engine.ready && engine.fixableInApp ? (
					<Button size="sm" onClick={enable} disabled={enabling}>
						{enabling ? "Enabling…" : "Enable"}
					</Button>
				) : undefined
			}
		/>
	);
}

/** Every part of the instance that can be half-configured, as one card of
 *  rows: what it is, what state it's in, and where to go and fix it. */
export function SetupChecklist({
	status,
	onChanged,
	onJump,
}: {
	status: SetupStatus;
	onChanged: () => void | Promise<void>;
	/** Offered on rows that aren't done yet, when a wizard is hosting this. */
	onJump?: (step: SetupStepId) => void;
}) {
	const fix = (step: SetupStepId, tone: ChipTone) =>
		onJump && tone === "warn" ? (
			<Button size="sm" variant="ghost" onClick={() => onJump(step)}>
				Set up
			</Button>
		) : undefined;

	const githubState = githubAuthState(status.github);
	const reposTone: ChipTone = status.repos.length > 0 ? "on" : "warn";
	const teamTone: ChipTone = status.team.count > 0 ? "on" : "warn";
	const bootable = status.repos.filter((r) => repoLifecycleState(r).tone === "on");
	const missing = status.repos.filter((r) => repoLifecycleState(r).tone !== "on");
	const namedMissing = missing
		.slice(0, 3)
		.map((r) => r.label)
		.join(", ");
	const restMissing = missing.length - 3;

	return (
		<SettingCard>
			<EngineRow engine={status.engine} onChanged={onChanged} />
			<ChecklistRow
				title="Repositories"
				description={
					status.repos.length > 0
						? status.repos.map((r) => r.label).join(", ")
						: "Register the repos sessions work in, under Workspace → Repositories."
				}
				tone={reposTone}
				label={
					status.repos.length > 0
						? `${status.repos.length} registered`
						: "None registered"
				}
				action={fix("repos", reposTone)}
			/>
			{status.repos.length > 0 && (
				<ChecklistRow
					title="Local dev setup"
					description={
						missing.length === 0
							? "Every repo commits lifecycle scripts, so sessions provision themselves, previews boot, and agents can check their own UI changes in a browser."
							: `No boot script in ${namedMissing}${restMissing > 0 ? ` and ${restMissing} more` : ""}. The Preview button stays disabled there. Add .agents/start.sh to the repo (docs/repo-lifecycle.md).`
					}
					tone={
						bootable.length === status.repos.length
							? "on"
							: bootable.length > 0
								? "warn"
								: "off"
					}
					label={`${bootable.length}/${status.repos.length} bootable`}
				/>
			)}
			<ChecklistRow
				title="Members"
				description={
					status.team.count > 0
						? status.team.names.join(", ")
						: "Add teammates so commits and sessions attribute to real people."
				}
				tone={teamTone}
				label={
					status.team.count > 0
						? `${status.team.count} ${status.team.count === 1 ? "member" : "members"}`
						: "Empty"
				}
				action={fix("team", teamTone)}
			/>
			<ChecklistRow
				title="GitHub sign-in"
				description={
					status.github.userPrAuth && status.github.clientIdConfigured
						? "Teammates sign in with GitHub and open PRs as themselves."
						: "Off. The UI uses the name picker and PRs come from the bot account."
				}
				tone={githubState.tone}
				label={githubState.label}
				action={fix("github", githubState.tone)}
			/>
			{status.integrations.map((i) => {
				const s = integrationState(i);
				return (
					<ChecklistRow
						key={i.id}
						title={i.label}
						description={
							s.tone === "on"
								? "Configured."
								: s.tone === "warn"
									? `Enabled, but missing ${i.missingRequired.join(", ")}.`
									: "Not enabled. Set it up when your team needs it."
						}
						tone={s.tone}
						label={s.label}
						action={fix("integrations", s.tone)}
					/>
				);
			})}
		</SettingCard>
	);
}
