// Which model a NEW session's picker opens on for this person: the default
// model they chose in Settings → Preferences, routed onto the default engine
// they chose beside it. This module is the rule; the preferences themselves,
// and the resolver that reads them, live in lib/default-engine-pref (the same
// split as lib/send-key and lib/send-key-pref, so the rule stays testable).
//
// Both are preselects rather than routing overrides, and the engine one has to
// be. Engine lives in the model id and nowhere else (lib/model-engine), so a
// bare picker id is what the composer sends both when somebody deliberately
// picks OpenCode and when they pick nothing at all — the server cannot tell
// those apart. Applying the preference to the id the composer starts with is
// therefore the only place it can go without overriding a deliberate choice.
// Picking another model afterwards keeps the engine, because the picker
// recomposes the new id onto the one the composer is already on.

import { baseModelId, engineModelId, type EngineId } from "./model-engine";

export interface NewSessionModelInput {
	/** The rows the picker lists (GET /api/models). */
	models: { id: string }[];
	/** The workspace/instance interactive default from the same response. */
	default: string;
	/** Settings → Preferences "Default model" ("" = no preference). */
	modelPref: string;
	/** Settings → Preferences "Default engine" ("" = no preference). */
	enginePref: string;
	/** Engine ids that are configured and enabled right now. */
	availableEngines: string[];
}

/**
 * The id to preselect, or "" for no preference — which the composer sends as
 * no model at all, leaving the choice to the server.
 *
 * An engine preference cannot travel that way, since the server never sees it,
 * so it names the catalog default explicitly instead. Fail-soft in both
 * directions: an engine that is no longer offered, and a model that cannot
 * route to it, both fall back to the unprefixed id rather than preselecting a
 * session that cannot run.
 */
export function preferredNewSessionModel(input: NewSessionModelInput): string {
	const base =
		input.modelPref && input.models.some((m) => m.id === input.modelPref)
			? input.modelPref
			: // A workspace default is an actual combination, not merely display
				// state: retain its id so create_session receives and stores it.
				baseModelId(input.default).startsWith("workspace-preset/")
				? input.default
				: "";
	const engine = input.enginePref;
	if (!engine || engine === "opencode") return base;
	if (!input.availableEngines.includes(engine)) return base;
	return engineModelId(engine as EngineId, base || input.default) ?? base;
}
