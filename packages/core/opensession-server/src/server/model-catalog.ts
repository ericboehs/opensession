import { toPiModel } from "./models";

export interface PickerPresetRequirement {
	group?: string;
	lead: { model: string };
	supporting?: Array<{ model: string }>;
}

/** Upstream provider needed to run one selectable model. */
export function modelUpstreamProvider(model: string): string | undefined {
	return toPiModel(model)?.match(/^pi\/([^/]+)\//)?.[1];
}

/**
 * Whether every provider a preset names is configured. The Dial is offered as
 * a cross-provider feature, so its whole tier family stays out of the picker
 * until both Anthropic and OpenAI are present, including its same-provider
 * lower tiers.
 */
export function presetFitsConfiguredProviders(
	preset: PickerPresetRequirement,
	configuredProviders: ReadonlySet<string>,
): boolean {
	const requiredProviders = new Set(
		[preset.lead, ...(preset.supporting || [])]
			.map((member) => modelUpstreamProvider(member.model))
			.filter((provider): provider is string => !!provider),
	);
	if (preset.group === "dial") {
		requiredProviders.add("anthropic");
		requiredProviders.add("openai");
	}
	return [...requiredProviders].every((provider) => configuredProviders.has(provider));
}
