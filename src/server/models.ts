/**
 * Model registry: which models sessions can run on, and which agent backend
 * ("provider") serves each one. Claude models run through the Claude Agent SDK
 * (claude-runner.ts); GPT/Codex models run through the Codex SDK
 * (codex-runner.ts). The session's `model` field is always stored as the
 * canonical id, never an alias.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { opencodePickerModels } from "./opencode-config";

export type Provider = "claude" | "codex" | "opencode";

export interface ModelInfo {
  id: string;
  provider: Provider;
  label: string;
  aliases: string[];
}

export const KNOWN_MODELS: ModelInfo[] = [
  { id: "claude-fable-5", provider: "claude", label: "Claude Fable 5", aliases: ["fable"] },
  { id: "claude-opus-4-8", provider: "claude", label: "Claude Opus 4.8", aliases: ["opus"] },
  { id: "claude-sonnet-5", provider: "claude", label: "Claude Sonnet 5", aliases: ["sonnet", "sonnet5"] },
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6", aliases: ["sonnet4.6"] },
  { id: "claude-haiku-4-5", provider: "claude", label: "Claude Haiku 4.5", aliases: ["haiku"] },
  { id: "codex-best-available", provider: "codex", label: "Best available (Codex)", aliases: ["best", "best-available", "best-codex"] },
  { id: "gpt-5.5", provider: "codex", label: "GPT-5.5 (Codex)", aliases: ["codex", "gpt", "gpt5.5"] },
  { id: "gpt-5.4", provider: "codex", label: "GPT-5.4 (Codex)", aliases: ["gpt5.4"] },
  { id: "gpt-5.4-mini", provider: "codex", label: "GPT-5.4 mini (Codex)", aliases: ["mini"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT-5.3 Codex Spark", aliases: ["spark"] },
];

// OpenCode engine models are opt-in only: `pickerModels` from
// ~/.backstage-opencode.json (and only while `enabled` is true) surface in
// the UI picker; any other opencode/<provider>/<model> id still resolves via
// the prefix passthrough in resolveModel below, it's just not advertised.
// Folded in at module load — a config change needs a reload to show up.
try {
  for (const id of opencodePickerModels()) {
    KNOWN_MODELS.push({
      id,
      provider: "opencode",
      label: `${id.slice("opencode/".length)} (OpenCode)`,
      aliases: [],
    });
  }
} catch {}

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

const FALLBACK_MODEL_ORDER = [
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.4",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

/**
 * Persisted override for the global default model, set from the Connections UI
 * (PUT /api/models/default). Lets us switch what new sessions run on without a
 * code change or restart. Resolution order: this override → MICHAEL_MODEL env →
 * DEFAULT_CLAUDE_MODEL. Stored as { model: "<id>" | null } in this file.
 */
const HOME = process.env.HOME || "/home/ubuntu";
const DEFAULT_MODEL_STORE = `${HOME}/.backstage-default-model.json`;
const FALLBACK_AUTO_STORE = `${HOME}/.backstage-model-fallback.json`;
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
 * Global default when a session has no model set: UI override → MICHAEL_MODEL
 * env → DEFAULT_CLAUDE_MODEL. Read fresh per call so UI changes take effect on
 * the next run without a restart.
 */
export function getDefaultModel(): string {
  return loadOverride() || process.env.MICHAEL_MODEL || DEFAULT_CLAUDE_MODEL;
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
 * Optional global fallback model when a run dies on usage limits with every
 * account in its pool exhausted. Unset means no automatic fallback; callers
 * that want fallback should pass an explicit per-session/per-automation
 * fallbackModel.
 */
export const DEFAULT_FALLBACK_MODEL: string | undefined = (() => {
  const v = (process.env.MICHAEL_FALLBACK_MODEL || "").trim().toLowerCase();
  if (v === "none") return undefined;
  return v || undefined;
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
 * Ordered model fallback chain after a provider's account pool is exhausted.
 * The explicitly configured fallback gets the first shot, then Backstage tries
 * the strongest known models across both providers. The caller tracks models
 * that already exhausted during this run and skips them.
 */
export function fallbackModelChain(
  primaryModel: string | undefined,
  preferredFallbackModel: string | undefined
): ModelInfo[] {
  const preferred = preferredFallbackModel
    ? resolveModel(preferredFallbackModel)
    : null;
  if (!preferred) return [];

  const primary = resolveModel(primaryModel || getDefaultModel());
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  const add = (model: ModelInfo | null) => {
    if (!model) return;
    if (model.id === primary?.id) return;
    if (model.id === BEST_AVAILABLE_CODEX_MODEL) {
      for (const id of CODEX_MODEL_ORDER) add(resolveModel(id));
      return;
    }
    if (seen.has(model.id)) return;
    seen.add(model.id);
    out.push(model);
  };

  add(preferred);
  for (const id of FALLBACK_MODEL_ORDER) add(resolveModel(id));
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
  return null;
}

/** Provider for a session's stored model (undefined/unknown → claude). */
export function providerFor(model?: string | null): Provider {
  if (!model) return resolveModel(getDefaultModel())?.provider ?? "claude";
  return resolveModel(model)?.provider ?? "claude";
}

export function modelLabel(model?: string | null): string {
  const id = model || getDefaultModel();
  return KNOWN_MODELS.find((m) => m.id === id)?.label || id;
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
