import { SettingsHeader, SettingsPanel } from "../../ui/settings";
import { ModelDefaultsSection, ModelEngineDefaultsSection } from "../Models";
import { ModelProvidersPanel } from "../ModelProviders";
import { WorkspaceModelPresetSettings } from "../WorkspaceModelPresets";
import type { Workspace } from "../../lib/types";

/** Models: which model a session starts on, which engine carries it, and any
 * provider you brought a key for. The subscription accounts behind the
 * Anthropic and OpenAI models live in Settings → Usage: their meters move
 * hourly and get read far more often than any of this gets changed. */
export function ModelsPanel({ workspace }: { workspace?: Workspace }) {
	return (
		<SettingsPanel>
			<SettingsHeader title="Models" />
			<ModelDefaultsSection />
			<WorkspaceModelPresetSettings workspace={workspace} />
			<ModelProvidersPanel />
			{/* Last: one row per model, Auto on all of them until someone pins
			    one, so it sits below everything people came here to read. */}
			<ModelEngineDefaultsSection />
		</SettingsPanel>
	);
}
