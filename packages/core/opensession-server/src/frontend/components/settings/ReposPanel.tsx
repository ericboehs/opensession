import { useEffect, useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsPanel,
} from "../../ui/settings";
import { Select, SettingRow } from "./shared";
import { InlineAlert } from "../../ui/state";
import { ReposSection } from "../SetupRepos";
import {
	configuredNewSessionRepo,
	fetchRepos,
	fetchWorktreeSettings,
	setNewSessionRepoApi,
	setSharedCheckoutMode,
	type RepoInfo,
	type WorktreeSettings,
} from "../../lib/api";
import { AUTO_REPO } from "../../lib/session-repo";
import { RepoTile } from "../RepoTile";
import { IconSparkle } from "../icons";
import { Switch } from "../../ui/switch";

/**
 * Where a new session starts for everyone who hasn't set their own preference
 * (Settings → Preferences overrides this). Auto reads the prompt and picks.
 *
 * Deliberately not the same thing as which repo is "the default" internally:
 * that one is a fallback that must always name a real checkout, so it can't
 * say Auto.
 */
function SharedCheckoutSetting() {
	const [settings, setSettings] = useState<WorktreeSettings | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchWorktreeSettings()
			.then((value) => alive && setSettings(value))
			.catch((cause) => alive && setError(cause.message));
		return () => {
			alive = false;
		};
	}, []);

	if (!settings) {
		return error ? (
			<InlineAlert className="mt-9">{error}</InlineAlert>
		) : (
			<SettingCardSkeleton
				rows={1}
				label="Loading worktree settings"
				className="mt-9"
			/>
		);
	}
	if (!settings.repos.length) return null;

	const repoNames = settings.repos.map((repo) => repo.label).join(", ");
	const isolated = settings.mode === "worktree";

	async function setIsolated(next: boolean) {
		const previous = settings;
		if (!previous) return;
		setSettings({ ...previous, mode: next ? "worktree" : "shared" });
		setSaving(true);
		setError(null);
		try {
			setSettings(await setSharedCheckoutMode(next ? "worktree" : "shared"));
		} catch (cause: any) {
			setSettings(previous);
			setError(cause?.message || "Couldn’t save the worktree setting");
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<SettingsGroupLabel>Shared checkouts</SettingsGroupLabel>
			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			<SettingCard>
				<SettingRow
					title="Use isolated worktrees"
					desc={`Create a separate worktree for new sessions in ${repoNames}. When off, they use the registered checkout. Existing sessions aren't moved.`}
					control={
						<Switch
							aria-label="Use isolated worktrees for shared checkouts"
							checked={isolated}
							disabled={saving}
							onCheckedChange={(next) => void setIsolated(next)}
						/>
					}
				/>
			</SettingCard>
		</>
	);
}

function DefaultRepoRow() {
	const [repos, setRepos] = useState<RepoInfo[]>([]);
	const [value, setValue] = useState("");
	useEffect(() => {
		// fetchRepos carries the setting alongside the list, so one load fills
		// both the options and the current choice.
		fetchRepos()
			.then((items) => {
				setRepos(items);
				setValue(configuredNewSessionRepo());
			})
			.catch(() => {});
	}, []);
	return (
		<SettingCard>
			<SettingRow
				title="Default repository"
				desc="Where a new session starts, for anyone who hasn't set their own. On Auto it reads the prompt and picks."
				control={
					<Select
						label="Default repository"
						value={value}
						options={[
							{
								value: AUTO_REPO,
								label: "Auto",
								icon: <IconSparkle size={16} />,
							},
							...repos.map((r) => ({
								value: r.id,
								label: r.label || r.id,
								icon: <RepoTile name={r.id} size={16} />,
							})),
						]}
						onChange={(next) => {
							setValue(next);
							void setNewSessionRepoApi(next).catch(() => {});
						}}
					/>
				}
			/>
		</SettingCard>
	);
}

// Workspace → Repositories: the registered repos, and the add flow, on a page
// of their own. Same section the Setup wizard's repos step renders — a repo
// added here and a repo added there are the same act. No restart banner:
// registering a repo takes effect immediately.

export function ReposPanel() {
	const { status, failed, refetch, applyRepo } = useSetupStatus();
	return (
		<SettingsPanel>
			<SettingsHeader
				title="Repositories"
				description="Register repositories and choose where their sessions work."
			/>
			{!status ? (
				// A failure is an alert, not a quiet label under a spinner: it used
				// to render in the loading register, so the sentence saying the
				// page had given up sat beside a mark saying it was still trying.
				failed ? (
					<InlineAlert>Couldn&rsquo;t load the repositories.</InlineAlert>
				) : (
					<>
						<SettingCardSkeleton rows={1} label="Loading repositories" />
						{/* mt-9 stands in for the group label above the list, which
						    counts the repos and so cannot be drawn before they
						    arrive. */}
						<SettingCardSkeleton rows={3} icon={28} className="mt-9" />
					</>
				)
			) : (
				<>
					<DefaultRepoRow />
					<SharedCheckoutSetting />
					<ReposSection
						repos={status.repos}
						onChanged={refetch}
						onRepoUpdated={applyRepo}
					/>
				</>
			)}
		</SettingsPanel>
	);
}
