import { useSetupStatus } from "../../hooks/useSetupStatus";
import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { LoadingState } from "../../ui/state";
import { ReposSection } from "../SetupRepos";
import { SetupRestart } from "../SetupRestart";

// Workspace → Repositories: the registered repos, and the add flow, on a page
// of their own. Same section the Setup wizard's repos step renders — a repo
// added here and a repo added there are the same act. Registration and branch
// changes apply immediately; changing the instance default needs a restart.

export function ReposPanel() {
	const setup = useSetupStatus();
	const { status, failed, refetch, applyRepo } = setup;
	return (
		<SettingsPanel className="relative">
			<SettingsHeader
				title="Repositories"
				description="Each session works in an isolated worktree of the repositories you register here."
			/>
			{!status ? (
				<LoadingState>
					{failed ? "Couldn't load the repositories." : "Loading…"}
				</LoadingState>
			) : (
				<ReposSection
					repos={status.repos}
					onChanged={refetch}
					onRepoUpdated={applyRepo}
				/>
			)}
			<SetupRestart setup={setup} />
		</SettingsPanel>
	);
}
