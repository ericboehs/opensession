import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { ClaudeAccountsSection, CodexAccountsSection } from "./ModelAccounts";

/** Usage: the subscription accounts runs draw from, and how close each one is
 * to its limit. Its own page rather than a section of Models because the two
 * are read on different clocks. These meters move hourly and answer "have we
 * got headroom", while a default model is set once and left alone. */
export function UsagePanel() {
	return (
		<SettingsPanel>
			<SettingsHeader title="Usage" />
			<ClaudeAccountsSection />
			<CodexAccountsSection />
		</SettingsPanel>
	);
}
