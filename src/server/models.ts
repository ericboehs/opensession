/**
 * Model registry: which models sessions can run on, and which agent backend
 * ("provider") serves each one. The session's `model` field is always stored
 * as the canonical id, never an alias.
 *
 * Single engine: EVERYTHING runs on the OpenCode engine (opencode-runner.ts) —
 * the legacy Claude/Codex SDK runners are deleted. The picker only surfaces
 * opencode ids (opencodePickerModels), interactiveDefaultModel maps the
 * default onto opencode, and nextFallbackModel / opencodeAutomationModel map
 * every fallback onto opencode too (toOpencodeModel). Native ids (claude-*,
 * gpt-*) stay RESOLVABLE (resolveModel prefix passthrough) for stored session
 * state, env vars and provider bookkeeping — agent-runner maps them onto
 * their opencode form at dispatch.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  opencodePickerModels,
  bridgeEnabled,
  opencodeProviders,
  BRIDGE_PROVIDER_IDS,
} from "./opencode-config";
import { envAlias, stateDir } from "./rename-compat";

export type Provider = "claude" | "codex" | "opencode";

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
  aliases: string[];
}

export const SESSION_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

const OPENAI_EFFORTS: SessionEffort[] = ["none", "low", "medium", "high", "xhigh"];
const CLAUDE_EFFORTS: SessionEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** OpenCode variants exposed by the configured model. Keep this aligned with
 * `opencode models <provider> --verbose`; the selected value is sent verbatim
 * as the prompt's `variant`. */
export function modelEfforts(model: string): SessionEffort[] {
  const id = model.replace(/^opencode\//, "");
  const slash = id.indexOf("/");
  const provider =
    slash === -1
      ? id.startsWith("claude-")
        ? "anthropic"
        : id.startsWith("gpt-")
          ? "openai"
          : ""
      : id.slice(0, slash);
  const slug = slash === -1 ? id : id.slice(slash + 1);

  if (provider === "openai" && /^gpt-5\./.test(slug)) return OPENAI_EFFORTS;
  if (provider === "anthropic") {
    if (slug.startsWith("claude-haiku-4-5")) return ["high", "max"];
    if (/^claude-(?:fable|opus|sonnet)-/.test(slug)) return CLAUDE_EFFORTS;
  }
  if (provider === "meta" && slug === "muse-spark-1.1") return OPENAI_EFFORTS;
  return [];
}

/** Preserve a supported selection, otherwise prefer High (the UI default). */
export function normalizeModelEffort(
  model: string,
  effort?: string | null
): SessionEffort | undefined {
  const supported = modelEfforts(model);
  if (!supported.length) return undefined;
  const normalized = effort?.trim().toLowerCase() as SessionEffort | undefined;
  if (normalized && supported.includes(normalized)) return normalized;
  return supported.includes("high") ? "high" : supported[0];
}

export const KNOWN_MODELS: ModelInfo[] = [
  { id: "claude-fable-5", provider: "claude", label: "Claude Fable 5", aliases: ["fable"] },
  { id: "claude-opus-4-8", provider: "claude", label: "Claude Opus 4.8", aliases: ["opus"] },
  { id: "claude-sonnet-5", provider: "claude", label: "Claude Sonnet 5", aliases: ["sonnet", "sonnet5"] },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6", aliases: ["sonnet4.6"] },
  { id: "claude-haiku-4-5", provider: "claude", label: "Claude Haiku 4.5", aliases: ["haiku"] },
  { id: "codex-best-available", provider: "codex", label: "Best available (Codex)", aliases: ["best", "best-available", "best-codex"] },
  { id: "gpt-5.6-sol", provider: "codex", label: "GPT-5.6 Sol", aliases: ["sol", "gpt5.6"] },
  { id: "gpt-5.6-terra", provider: "codex", label: "GPT-5.6 Terra", aliases: ["terra"] },
  { id: "gpt-5.6-luna", provider: "codex", label: "GPT-5.6 Luna", aliases: ["luna"] },
  { id: "gpt-5.5", provider: "codex", label: "GPT-5.5 (Codex)", aliases: ["codex", "gpt", "gpt5.5"] },
  { id: "gpt-5.4", provider: "codex", label: "GPT-5.4 (Codex)", aliases: ["gpt5.4"] },
  { id: "gpt-5.4-mini", provider: "codex", label: "GPT-5.4 mini (Codex)", aliases: ["mini"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT-5.3 Codex Spark", aliases: ["spark"] },
];

/** "claude-opus-4-8" → "Opus 4.8", "gpt-5.4-mini" → "GPT-5.4 mini". Fallback
 * prettifier for model slugs with no native registry entry to borrow from. */
function prettifyModelSlug(slug: string): string {
  if (slug.startsWith("gpt-")) {
    const m = slug.slice(4).match(/^(\d+(?:[.-]\d+)*)(?:-(.+))?$/);
    if (m) return `GPT-${m[1].replace(/-/g, ".")}${m[2] ? ` ${m[2].replace(/-/g, " ")}` : ""}`;
    return `GPT-${slug.slice(4)}`;
  }
  const words: string[] = [];
  const nums: string[] = [];
  for (const part of slug.replace(/^claude-/, "").split("-")) {
    if (/^\d/.test(part)) nums.push(part);
    else if (part) words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return [words.join(" "), nums.join(".")].filter(Boolean).join(" ") || slug;
}

/**
 * Friendly label for an opencode/<provider>/<model> id: just the model name
 * ("Sonnet 5", "GPT-5.5") — the OpenCode engine is an implementation detail,
 * never part of the display name. Borrows the native registry's label when the
 * tail matches a known model id, so opencode entries read exactly like the
 * native ones always have.
 */
export function opencodeModelLabel(id: string): string {
  const tail = id.split("/").pop() || id;
  const native = KNOWN_MODELS.find((m) => m.provider !== "opencode" && m.id === tail);
  const base = native?.label || prettifyModelSlug(tail);
  return base.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

/** The models a session can actually select — the same live set the picker and
 *  GET /api/models expose (the opencode-provider entries, refreshed from
 *  opencode's picker; the full registry as a fallback when opencode isn't
 *  configured). Used to list choices dynamically instead of hardcoding names. */
export function selectableModels(): { id: string; label: string }[] {
  const opencodeOnly = KNOWN_MODELS.filter((m) => m.provider === "opencode");
  const list = opencodeOnly.length ? opencodeOnly : KNOWN_MODELS;
  return list.map((m) => ({ id: m.id, label: m.label }));
}

// OpenCode engine models are opt-in only: `pickerModels` from
// ~/.opensession-opencode.json (and only while `enabled` is true) surface in
// the UI picker; any other opencode/<provider>/<model> id still resolves via
// the prefix passthrough in resolveModel below, it's just not advertised.
// Folded in at module load; the model-providers settings routes call
// refreshOpencodePickerModels() after any pickerModels write so the picker
// updates without a reload.
export function refreshOpencodePickerModels(): void {
  for (let i = KNOWN_MODELS.length - 1; i >= 0; i--) {
    if (KNOWN_MODELS[i].provider === "opencode") KNOWN_MODELS.splice(i, 1);
  }
  try {
    // Third-party providers only surface once they have an API key (Settings →
    // Model providers) — a keyless entry would just produce auth errors.
    // anthropic/openai ride the subscription bridges, never raw keys.
    const keyed = new Set(
      Object.entries(opencodeProviders())
        .filter(([, p]) => !!p.apiKey)
        .map(([id]) => id)
    );
    const usable = (id: string) => {
      const provider = id.split("/")[1] || "";
      return BRIDGE_PROVIDER_IDS.has(provider) || keyed.has(provider);
    };
    for (const id of opencodePickerModels()) {
      if (!usable(id)) continue;
      KNOWN_MODELS.push({
        id,
        provider: "opencode",
        label: opencodeModelLabel(id),
        aliases: [],
      });
    }
  } catch {}
}
refreshOpencodePickerModels();

/** Per-provider defaults: claude-fable-5 for Anthropic, gpt-5.5 for OpenAI. */
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const BEST_AVAILABLE_CODEX_MODEL = "codex-best-available";

const CODEX_MODEL_ORDER = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

/**
 * Fallback ROUTING tiers (higher = smarter). NOT an absolute capability
 * ranking — it encodes the policy Michiel set (2026-07-11): keep a run going on
 * an equal-or-smarter model automatically, but ASK a human before dropping to a
 * dumber one. "smart→smart / medium→smart = fine (auto); smart→dumb /
 * medium→dumb = ask." Concrete edges that policy yields: Fable→Sol auto,
 * Fable→Opus ask, Opus→Sol auto, Opus→Sonnet ask, Sol→Opus ask.
 *
 * Unlisted models default to tier 1 (treated as a downgrade from any premium
 * primary, so the human is asked — the safe default).
 */
const FALLBACK_TIER: Record<string, number> = {
  "claude-fable-5": 3,
  "gpt-5.6-sol": 3,
  "gpt-5.6-terra": 3,
  "gpt-5.6-luna": 3,
  "claude-opus-4-8": 2,
  "gpt-5.5": 2,
  "claude-sonnet-5": 1,
  "gpt-5.4": 1,
  "claude-sonnet-4-6": 1,
  "claude-haiku-4-5": 0,
  "gpt-5.4-mini": 0,
  "gpt-5.3-codex-spark": 0,
};

/**
 * Ordered fallback DESTINATIONS, most-desirable first. A run that exhausts its
 * model walks this list for the next usable one; the per-hop auto/ask mode then
 * comes from the tier comparison (nextFallbackModel).
 *
 * Fable is deliberately ABSENT — it's a fallback *source*, never a destination:
 * its weekly-scoped credit pool is the scarce thing we're usually falling *off*
 * of, so routing another exhausted model back into it would just re-hit the cap.
 */
const FALLBACK_DESTINATIONS = [
  "gpt-5.6-sol",
  "claude-opus-4-8",
  "gpt-5.5",
  "claude-sonnet-5",
  "gpt-5.4",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

/**
 * Persisted override for the global default model, set from the Connections UI
 * (PUT /api/models/default). Lets us switch what new sessions run on without a
 * code change or restart. Resolution order: this override → OPENSESSION_MODEL env
 * (MICHAEL_MODEL accepted as a deprecated alias) →
 * DEFAULT_CLAUDE_MODEL. Stored as { model: "<id>" | null } in this file.
 */
const DEFAULT_MODEL_STORE = stateDir("default-model.json");
const FALLBACK_AUTO_STORE = stateDir("model-fallback.json");
const CODEX_MODEL_EXHAUST_MS = 60 * 60 * 1000;
const codexModelExhaustedUntil = new Map<string, number>();

// undefined = not yet loaded from disk; null = no override set.
let overrideCache: string | null | undefined;

function loadOverride(): string | null {
  if (overrideCache !== undefined) return overrideCache;
  try {
    if (existsSync(DEFAULT_MODEL_STORE)) {
      const raw = JSON.parse(readFileSync(DEFAULT_MODEL_STORE, "utf8"));
      const id = typeof raw?.model === "string" ? raw.model.trim() : "";
      overrideCache = id && resolveModel(id) ? resolveModel(id)!.id : null;
    } else {
      overrideCache = null;
    }
  } catch {
    overrideCache = null;
  }
  return overrideCache;
}

/**
 * Global default when a session has no model set: UI override → OPENSESSION_MODEL
 * env → DEFAULT_CLAUDE_MODEL. Read fresh per call so UI changes take effect on
 * the next run without a restart.
 */
export function getDefaultModel(): string {
  return loadOverride() || envAlias("OPENSESSION_MODEL", "MICHAEL_MODEL") || DEFAULT_CLAUDE_MODEL;
}

/**
 * Persist the UI-selected default model (or clear it with null to fall back to
 * env/constant). Returns the resolved default after the change; throws on an
 * unknown model id.
 */
export function setDefaultModel(input: string | null): string {
  if (input === null || input.trim() === "") {
    overrideCache = null;
    try {
      writeJsonAtomic(DEFAULT_MODEL_STORE, { model: null });
    } catch {}
    return getDefaultModel();
  }
  const m = resolveModel(input);
  if (!m) throw new Error(`Unknown model: ${input}`);
  overrideCache = m.id;
  writeJsonAtomic(DEFAULT_MODEL_STORE, { model: m.id });
  return m.id;
}

/**
 * Global fallback model when a run dies on usage limits with every account in
 * its pool exhausted (e.g. the weekly-scoped Fable cap). Defaults to Opus —
 * strong and abundant, so an interactive session keeps working instead of
 * stalling on the limit notice. Override with OPENSESSION_FALLBACK_MODEL, or
 * set it to "none" to disable the automatic fallback entirely.
 */
export const DEFAULT_FALLBACK_MODEL: string | undefined = (() => {
  const v = (envAlias("OPENSESSION_FALLBACK_MODEL", "MICHAEL_FALLBACK_MODEL") || "").trim().toLowerCase();
  if (v === "none") return undefined;
  return v || "claude-opus-4-8";
})();

/**
 * Whether interactive sessions auto-switch when they have an explicit fallback
 * model. On (the default) = use that configured fallback; off ("manual") = stop
 * on the limit notice and let the human pick the next model. Persisted so the
 * choice survives a restart; read fresh per run so a UI toggle takes effect
 * without one.
 *
 * Stored as { auto: boolean } in FALLBACK_AUTO_STORE. This toggle only governs
 * interactive sessions; it does not create a fallback model by itself.
 */
let fallbackAutoCache: boolean | undefined;

export function getModelFallbackAuto(): boolean {
  if (fallbackAutoCache !== undefined) return fallbackAutoCache;
  try {
    if (existsSync(FALLBACK_AUTO_STORE)) {
      const raw = JSON.parse(readFileSync(FALLBACK_AUTO_STORE, "utf8"));
      fallbackAutoCache = raw?.auto !== false; // default on for anything but explicit false
    } else {
      fallbackAutoCache = true;
    }
  } catch {
    fallbackAutoCache = true;
  }
  return fallbackAutoCache;
}

export function setModelFallbackAuto(auto: boolean): boolean {
  fallbackAutoCache = auto;
  try {
    writeJsonAtomic(FALLBACK_AUTO_STORE, { auto });
  } catch {}
  return auto;
}

function isCodexModelExhausted(model: string): boolean {
  const until = codexModelExhaustedUntil.get(model);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    codexModelExhaustedUntil.delete(model);
    return false;
  }
  return true;
}

export function markCodexModelExhausted(model: string): void {
  const resolved = resolveModel(model);
  if (!resolved || resolved.provider !== "codex") return;
  if (resolved.id === BEST_AVAILABLE_CODEX_MODEL) return;
  const until = Date.now() + CODEX_MODEL_EXHAUST_MS;
  codexModelExhaustedUntil.set(resolved.id, until);
  console.warn(
    `[models] ${resolved.id} marked unavailable until ${new Date(until).toISOString()}`
  );
}

export function resolveConcreteModel(
  model?: string | null,
  exclude?: Set<string>
): string {
  const resolved = model ? resolveModel(model) : resolveModel(getDefaultModel());
  if (resolved?.id !== BEST_AVAILABLE_CODEX_MODEL) {
    return resolved?.id || getDefaultModel();
  }

  for (const id of CODEX_MODEL_ORDER) {
    if (exclude?.has(id)) continue;
    if (!isCodexModelExhausted(id)) return id;
  }
  for (const id of CODEX_MODEL_ORDER) {
    if (!exclude?.has(id)) return id;
  }
  return DEFAULT_CODEX_MODEL;
}

/**
 * Fallback model for an interactive session, or undefined when no fallback is
 * explicitly configured. This no longer invents a Claude → Codex fallback.
 */
export function interactiveFallbackModel(_primaryModel?: string): string | undefined {
  if (!getModelFallbackAuto()) return undefined;
  return DEFAULT_FALLBACK_MODEL;
}

/**
 * Map a native/legacy model id onto its OpenCode-engine equivalent so the
 * single-engine core (interactive picker + automations + the usage-limit
 * fallback chain) always dispatches through the opencode runner:
 *
 *   gpt-5.5 / codex-*        → opencode/openai/<model>   (ChatGPT-sub / codex accounts)
 *   claude-*                 → opencode/anthropic/<model> (meridian/native bridge)
 *   opencode/…               → unchanged
 *
 * Fail-safe (mirrors opencodeAutomationModel): the anthropic path is gated on
 * the bridge being enabled — with it off, claude ids stay native so a config
 * toggle degrades to the direct SDK runner instead of failing. The openai path
 * keys off codex accounts (not the bridge flag), so it always maps. This is
 * *model selection*, not execution: native ids still resolve (resolveModel) and
 * still run on the Claude/Codex SDK when the direct agent loops (Slack, Linear,
 * github, Plain) dispatch them — those loops are not migrated in this pass.
 */
export function toOpencodeModel(model?: string | null): string | undefined {
  const m = (model || "").trim();
  if (!m) return model ?? undefined;
  if (m.startsWith("opencode/")) return m;
  if (m === BEST_AVAILABLE_CODEX_MODEL || m.startsWith("codex-")) {
    return `opencode/openai/${DEFAULT_CODEX_MODEL}`;
  }
  if (m.startsWith("gpt-")) return `opencode/openai/${m}`;
  // Always map claude-* (no bridgeEnabled() fail-safe anymore): opencode is
  // the only engine, so with the bridge disabled an anthropic run should die
  // on the runner's clear "bridge disabled" error instead of silently
  // degrading — there is nothing left to degrade to.
  if (m.startsWith("claude-")) return `opencode/anthropic/${m}`;
  // A bare "<provider>/<model>" (e.g. "openai/gpt-5.6-sol") written without the
  // engine prefix → opencode passthrough. Mirrors resolveModel so an id maps the
  // same whichever seam sees it first, instead of degrading to the default.
  if (m.includes("/")) return `opencode/${m}`;
  return model ?? undefined;
}

/**
 * Default model for interactive Backstage sessions and the picker: the global
 * default mapped onto the opencode engine (so new interactive sessions and the
 * picker's "default" row run on opencode). getDefaultModel() itself is left
 * native — the direct agent loops (Slack/Linear/Plain) still read it and run it
 * on the SDK — so this is deliberately a separate, interactive-only default.
 */
export function interactiveDefaultModel(): string {
  return toOpencodeModel(getDefaultModel()) || getDefaultModel();
}

/** Strip the opencode engine prefix so a mapped id ("opencode/openai/gpt-5.6-sol")
 *  resolves to its native key ("gpt-5.6-sol") for tier lookup. Native ids pass
 *  through unchanged. */
function nativeModelId(id: string | undefined | null): string {
  return (id || "").replace(/^opencode\/[^/]+\//, "");
}

/** Routing tier for a model id (native or opencode-mapped). Unlisted → 1. */
export function fallbackTier(id: string | undefined | null): number {
  const t = FALLBACK_TIER[nativeModelId(id)];
  return t === undefined ? 1 : t;
}

export type FallbackMode = "auto" | "ask";
export interface FallbackHop {
  /** opencode-mapped id to run next */
  id: string;
  /** "auto" = keep going silently (equal-or-smarter); "ask" = confirm with a
   *  human first (downgrade to a dumber model). */
  mode: FallbackMode;
}

/**
 * The next model to try after `currentModel` has run out (usage-exhausted on
 * every account, or hit an unrecoverable transient failure). Walks
 * FALLBACK_DESTINATIONS (plus an explicitly-configured `preferred` first),
 * skipping the current engine model and anything already exhausted this run,
 * and orders auto-eligible (equal-or-smarter) candidates ahead of downgrades so
 * we keep the strongest usable model. Returns null when nothing is left.
 *
 * `mode` is the tier comparison against the model we're LEAVING: equal-or-higher
 * tier ⇒ "auto" (Fable→Sol, Opus→Sol), lower ⇒ "ask" (Fable→Opus, Opus→Sonnet,
 * Sol→Opus). All ids in/out are opencode-mapped.
 */
export function nextFallbackModel(
  currentModel: string,
  exhausted: Set<string>,
  preferredFallbackModel?: string
): FallbackHop | null {
  const currentOc = toOpencodeModel(currentModel) || currentModel;
  const currentTier = fallbackTier(currentOc);

  const candidates: string[] = [];
  const add = (id: string | undefined | null) => {
    if (!id) return;
    if (id === BEST_AVAILABLE_CODEX_MODEL) {
      for (const c of CODEX_MODEL_ORDER) add(c);
      return;
    }
    const oc = toOpencodeModel(id);
    if (!oc || oc === currentOc || exhausted.has(oc) || candidates.includes(oc)) return;
    if (!resolveModel(oc)) return;
    candidates.push(oc);
  };
  if (preferredFallbackModel && preferredFallbackModel !== "none") add(preferredFallbackModel);
  for (const id of FALLBACK_DESTINATIONS) add(id);
  if (!candidates.length) return null;

  // Stable sort (candidates already in preference order): auto-eligible first,
  // then by descending tier — so we always reach for the strongest model we can
  // keep going on before offering a downgrade.
  candidates.sort((a, b) => {
    const aDown = fallbackTier(a) >= currentTier ? 0 : 1;
    const bDown = fallbackTier(b) >= currentTier ? 0 : 1;
    if (aDown !== bDown) return aDown - bDown;
    return fallbackTier(b) - fallbackTier(a);
  });

  const to = candidates[0];
  return { id: to, mode: fallbackTier(to) >= currentTier ? "auto" : "ask" };
}

/**
 * The full ordered fallback plan from a primary model — repeated
 * nextFallbackModel hops until the graph is dry. Exported for tests and any
 * caller that wants to preview the chain; the live runner uses nextFallbackModel
 * directly so a hop's mode is evaluated against the model actually being left.
 */
export function fallbackPlan(
  primaryModel: string | undefined,
  preferredFallbackModel: string | undefined
): FallbackHop[] {
  if (!preferredFallbackModel || preferredFallbackModel === "none") return [];
  const exhausted = new Set<string>();
  const out: FallbackHop[] = [];
  let current = toOpencodeModel(primaryModel || getDefaultModel()) || getDefaultModel();
  for (let i = 0; i < 32; i++) {
    const hop = nextFallbackModel(current, exhausted, preferredFallbackModel);
    if (!hop) break;
    out.push(hop);
    exhausted.add(hop.id);
    current = hop.id;
  }
  return out;
}

/**
 * Resolve user input (alias or id, any case) to a model. Unknown ids that
 * carry a clear provider prefix pass through so new models work without a
 * registry bump; anything else is rejected.
 */
export function resolveModel(input: string): ModelInfo | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  for (const m of KNOWN_MODELS) {
    if (m.id === s || m.aliases.includes(s)) return m;
  }
  if (s.startsWith("claude-")) return { id: s, provider: "claude", label: s, aliases: [] };
  if (s.startsWith("gpt-") || s.startsWith("codex-")) {
    return { id: s, provider: "codex", label: s, aliases: [] };
  }
  // OpenCode engine: explicit opencode/<provider>/<model> ids pass through —
  // the only way a session lands on the opencode runner (nothing defaults to it).
  if (s.startsWith("opencode/") && s.slice("opencode/".length).includes("/")) {
    return { id: s, provider: "opencode", label: s, aliases: [] };
  }
  // A bare "<provider>/<model>" (e.g. "openai/gpt-5.6-sol", "anthropic/claude-…")
  // is an opencode engine id written without the engine prefix — a shape a
  // workflow's agent({model}) override can easily use. Normalize it to the
  // opencode form so it resolves to the intended model instead of falling
  // through to null (which silently degrades callers to the default model).
  if (s.includes("/")) {
    const id = `opencode/${s}`;
    return { id, provider: "opencode", label: id, aliases: [] };
  }
  return null;
}

/** Provider for a session's stored model (undefined/unknown → claude). */
export function providerFor(model?: string | null): Provider {
  if (!model) return resolveModel(getDefaultModel())?.provider ?? "claude";
  return resolveModel(model)?.provider ?? "claude";
}

export function modelLabel(model?: string | null): string {
  const id = model || getDefaultModel();
  const known = KNOWN_MODELS.find((m) => m.id === id)?.label;
  if (known) return known;
  // Non-picker opencode ids still deserve a friendly name, not a slashed slug.
  if (id.startsWith("opencode/")) return opencodeModelLabel(id);
  return id;
}

// ── Pricing & context windows (for live cost/context reporting) ──────────────
//
// Per-model price per 1M tokens, matching the public Claude API rate card — the
// same rates the subscription usage-credits are billed at. Claude runs report an
// authoritative `total_cost_usd` from the SDK (we use that directly and never
// recompute); this table is the fallback for Codex/GPT models, which report token
// counts but no cost. GPT-5.x Codex pricing is a best-effort placeholder — treat
// Codex cost as approximate. `contextWindow` is the model's token ceiling, used
// as the denominator for the context-fill gauge.

export interface ModelPricing {
  /** USD per 1M input tokens (uncached). */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens (~0.1× input). */
  cacheRead: number;
  /** USD per 1M cache-write tokens (~1.25× input, 5-minute TTL). */
  cacheWrite: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic rate card ($/1M). Cache read ≈ 0.1× input, cache write ≈ 1.25× input.
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // Codex/GPT — approximate; no authoritative cost from the SDK.
  "gpt-5.5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
  "gpt-5.4": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
  "gpt-5.4-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.3125 },
  "gpt-5.3-codex-spark": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.3125 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Codex/GPT — approximate.
  "gpt-5.5": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex-spark": 400_000,
};

/** Context-window token ceiling for a model (0 if unknown → gauge hidden). */
export function contextWindowFor(model?: string | null): number {
  const id = resolveModel(model || getDefaultModel())?.id || model || "";
  return CONTEXT_WINDOWS[id] ?? 0;
}

/** Whether we have an authoritative price table entry (vs. a passthrough id). */
export function hasPricing(model?: string | null): boolean {
  const id = resolveModel(model || "")?.id || model || "";
  return id in PRICING;
}

/**
 * Compute USD cost for a set of token counts at a model's rate. Used for Codex
 * (which reports no cost); for Claude we prefer the SDK's exact `total_cost_usd`.
 * Returns undefined when the model has no known pricing.
 */
export function priceUsageUsd(
  model: string | null | undefined,
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }
): number | undefined {
  const id = resolveModel(model || "")?.id || model || "";
  const p = PRICING[id];
  if (!p) return undefined;
  const M = 1_000_000;
  return (
    ((tokens.input || 0) * p.input +
      (tokens.output || 0) * p.output +
      (tokens.cacheRead || 0) * p.cacheRead +
      (tokens.cacheWrite || 0) * p.cacheWrite) /
    M
  );
}

/** Human list for /model help output. */
export function formatModelList(current?: string | null): string {
  const cur = current || getDefaultModel();
  return KNOWN_MODELS.map((m) => {
    const marker = m.id === cur ? "→ " : "   ";
    const aliases = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
    return `${marker}${m.id}${aliases} — ${m.label}`;
  }).join("\n");
}
