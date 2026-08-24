import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { TeamSection } from "../SetupTeam";

// Workspace → Members: the identity table, on a page of its own. Commit
// attribution, `allowedUsers` scoping and GitHub sign-in all resolve through
// it, so it long outlives the Setup wizard step that first fills it in.

export function MembersPanel() {
	return (
		<SettingsPanel>
			<SettingsHeader
				title="Members"
				description="Members from your GitHub organization are added automatically."
			/>
			<TeamSection onChanged={() => {}} githubOnly />
		</SettingsPanel>
	);
}
