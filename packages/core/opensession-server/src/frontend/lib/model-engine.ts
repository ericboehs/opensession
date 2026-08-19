/**
 * Engine routing lives in the model id, and nowhere else.
 *
 * The model list is engine-agnostic: one entry per model/preset, and which
 * engine runs it is a routing PREFIX over that entry's picker id. There is no
 * separate engine field on a session, a prompt, or a create request — a
 * prefixed id is the whole signal, which is what keeps the composer, the
 * new-session flow and the server in agreement without a second knob to drift.
 *
 *   opencode  the bare picker id            "opencode/anthropic/claude-opus-5"
 *                                           "dial/opus-fable"
 *   pi        "pi/<rest>"                   "pi/anthropic/claude-opus-5"
 *   claude    "claude/<rest>"               "claude/anthropic/claude-opus-5"
 *   codex     "codex/<rest>"                "codex/openai/gpt-5.6-sol"
 *
 * `<rest>` is the picker id with its own "opencode/" head dropped, so the
 * upstream provider segment stays visible ("pi/anthropic/claude-opus-5", not
 * "pi/opencode/anthropic/claude-opus-5"). Preset ids (dial, orchestrator,
 * workspace-preset) carry no provider segment and are prefixed whole.
 */

export const ENGINE_IDS = ["claude", "codex", "opencode", "pi"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** One engine as /api/models advertises it. */
export interface EngineOption {
	id: EngineId;
	label: string;
	/** Configured AND enabled. Unavailable engines never reach the picker. */
	available: boolean;
}

/** Engines that route by prefix; opencode is the unprefixed base form. */
const PREFIX_ENGINES = ["pi", "claude", "codex"] as const;

/** Preset id heads that carry no upstream provider segment. */
const PRESET_HEADS = ["dial/", "orchestrator/", "workspace-preset/"];

function isPresetId(id: string): boolean {
	return PRESET_HEADS.some((head) => id.startsWith(head));
}

/**
 * The engine an id routes to. Unprefixed ids are opencode — including the
 * legacy native "claude-opus-5" / "gpt-5.5" slugs, which are not engine ids at
 * all (they are bare model slugs the direct agent loops still resolve) and
 * never carry a routing prefix.
 */
export function modelEngine(id: string): EngineId {
	for (const engine of PREFIX_ENGINES) {
		if (id.startsWith(`${engine}/`)) return engine;
	}
	return "opencode";
}

/**
 * Strip an engine-routing prefix back to the id the picker lists:
 * "pi/anthropic/claude-opus-5" → "opencode/anthropic/claude-opus-5",
 * "claude/dial/opus-fable" → "dial/opus-fable". Unprefixed ids pass through.
 * Label, effort, account and selection lookups all resolve through this — the
 * prefix is routing, not a different model.
 */
export function baseModelId(id: string): string {
	const engine = modelEngine(id);
	if (engine === "opencode") return id;
	const rest = id.slice(engine.length + 1);
	return isPresetId(rest) ? rest : `opencode/${rest}`;
}

/**
 * The upstream vendor of a picker id ("anthropic", "openai", "xai", …), or
 * null for presets and legacy native slugs, which name no single upstream.
 */
export function modelVendor(id: string): string | null {
	const base = baseModelId(id);
	if (!base.startsWith("opencode/")) return null;
	const rest = base.slice("opencode/".length);
	const slash = rest.indexOf("/");
	return slash > 0 ? rest.slice(0, slash) : null;
}

/**
 * Does this id end up talking to Anthropic? The vendor segment answers it for
 * an ordinary picker id; a preset or a legacy native slug carries no segment,
 * so the catalog entry's account pool answers instead ("claude" is the
 * Anthropic pool; accountProviderForModel in the server's models.ts resolves
 * presets down to their main model before naming it).
 *
 * Only prompt-cache economics ask this question today: an Anthropic prompt
 * cache is keyed on the whole prefix, so changing what sits in it re-uploads
 * the conversation. OpenAI's caching does not work that way.
 */
export function isAnthropicModel(
	id: string,
	accountProvider?: string | null,
): boolean {
	const vendor = modelVendor(id);
	if (vendor !== null) return vendor === "anthropic";
	return accountProvider === "claude";
}

/**
 * Compose a picker id onto an engine, or null when the entry cannot route
 * there. Two reasons it cannot:
 *
 *  - the id carries no prefixable shape (the legacy native slugs), or
 *  - the direct-SDK engines only speak to their own vendor: claude serves
 *    Anthropic models, codex serves OpenAI ones. An id with no vendor of its
 *    own (a dial/orchestrator/workspace preset) is left routable — the preset
 *    names its own models, and the engine resolves them.
 */
export function engineModelId(engine: EngineId, id: string): string | null {
	const base = baseModelId(id);
	if (engine === "opencode") return base;
	const rest = base.startsWith("opencode/")
		? base.slice("opencode/".length)
		: isPresetId(base)
			? base
			: null;
	if (rest === null) return null;
	if (engine === "claude" || engine === "codex") {
		const vendor = modelVendor(base);
		const wanted = engine === "claude" ? "anthropic" : "openai";
		if (vendor !== null && vendor !== wanted) return null;
	}
	return `${engine}/${rest}`;
}

/** Back-compat alias for the pi-only composer this generalizes. */
export function piModelId(id: string): string | null {
	return engineModelId("pi", id);
}

/**
 * The key a per-model default engine is stored under: the bare model slug
 * ("claude-opus-5", "gpt-5.6-sol"), or the whole preset id for entries with no
 * provider segment. Never engine-prefixed — the map answers "which engine runs
 * this model by default", so a prefixed key would double-route.
 */
export function modelEngineKey(id: string): string {
	const base = baseModelId(id);
	if (!base.startsWith("opencode/")) return base;
	const rest = base.slice("opencode/".length);
	const slash = rest.indexOf("/");
	return slash > 0 ? rest.slice(slash + 1) : rest;
}
