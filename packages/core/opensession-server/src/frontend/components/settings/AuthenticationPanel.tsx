import { useSetupStatus } from "../../hooks/useSetupStatus";
import {
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { GithubAuthCard } from "../SetupIntegrations";
import { SetupRestart } from "../SetupRestart";

// Organization → Authentication: the workspace sign-in method and the GitHub
// App that backs it. Bot credentials stay App-only whether sign-in is None or
// GitHub; this page controls only whether teammates authenticate through it.
export function AuthenticationPanel() {
	const setup = useSetupStatus();
	const { status, failed } = setup;
	return (
		<SettingsPanel className="relative">
			<SettingsHeader
				title="Authentication"
				description="Choose how teammates sign in to this workspace."
			/>
			{!status ? (
				failed ? (
					<InlineAlert>Couldn&rsquo;t load authentication settings.</InlineAlert>
				) : (
					<SettingCardSkeleton rows={1} icon={40} label="Loading authentication" />
				)
			) : (
				<>
					<SettingsGroupLabel>Sign-in method</SettingsGroupLabel>
					<GithubAuthCard github={status.github} onSaved={setup.applyGithub} />
					<SettingsHint>
						None leaves the workspace open. GitHub requires every teammate to sign in
						with their configured GitHub account.
					</SettingsHint>
				</>
			)}
			<SetupRestart setup={setup} />
		</SettingsPanel>
	);
}
