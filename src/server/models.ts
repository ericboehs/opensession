/**
 * Model registry: which models sessions can run on, and which agent backend
 * ("provider") serves each one. Claude models run through the Claude Agent SDK
 * (claude-runner.ts); GPT/Codex models run through the Codex SDK
 * (codex-runner.ts). The session's `model` field is always stored as the
 * canonical id, never an alias.
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";

export type Provider = "claude" | "codex";

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
  { id: "gpt-5.5", provider: "codex", label: "GPT-5.5 (Codex)", aliases: ["codex", "gpt", "gpt5.5"] },
  { id: "gpt-5.4", provider: "codex", label: "GPT-5.4 (Codex)", aliases: ["gpt5.4"] },
  { id: "gpt-5.4-mini", provider: "codex", label: "GPT-5.4 mini (Codex)", aliases: ["mini"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT-5.3 Codex Spark", aliases: ["spark"] },
];

/** Per-provider defaults: claude-fable-5 for Anthropic, gpt-5.5 for OpenAI. */
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";

/**
 * Persisted override for the global default model, set from the Connections UI
 * (PUT /api/models/default). Lets us switch what new sessions run on without a
 * code change or restart. Resolution order: this override → MICHAEL_MODEL env →
 * DEFAULT_CLAUDE_MODEL. Stored as { model: "<id>" | null } in this file.
 */
const HOME = process.env.HOME || "/home/ubuntu";
const DEFAULT_MODEL_STORE = `${HOME}/.backstage-default-model.json`;

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
 * Global fallback model when a run dies on usage limits with every account in
 * its pool exhausted (Slack/Linear agents and automations without their own
 * fallbackModel). MICHAEL_FALLBACK_MODEL=none disables it.
 */
export const DEFAULT_FALLBACK_MODEL: string | undefined = (() => {
  const v = (process.env.MICHAEL_FALLBACK_MODEL || "").trim().toLowerCase();
  if (v === "none") return undefined;
  return v || DEFAULT_CODEX_MODEL;
})();

/**
 * Fallback model for an *interactive* session running on `primaryModel`.
 *
 * Fable has its own (small) weekly cap that's separate from the account's
 * general 5-hour / 7-day capacity — so a Fable session can exhaust Fable
 * pool-wide ("You're out of usage credits") while every account still has
 * plenty of general capacity left. In that case Sonnet on the *same* provider
 * is the right fallback: it resumes the session in-place (no cross-provider
 * fresh start) and draws on that still-available general capacity. Any other
 * primary uses the global cross-provider default. Honors MICHAEL_FALLBACK_MODEL=none.
 */
export function interactiveFallbackModel(primaryModel?: string): string | undefined {
  if (DEFAULT_FALLBACK_MODEL === undefined) return undefined;
  const primary = resolveModel(primaryModel || getDefaultModel());
  if (primary?.id === "claude-fable-5") return "claude-sonnet-5";
  return DEFAULT_FALLBACK_MODEL;
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

/** Human list for /model help output. */
export function formatModelList(current?: string | null): string {
  const cur = current || getDefaultModel();
  return KNOWN_MODELS.map((m) => {
    const marker = m.id === cur ? "→ " : "   ";
    const aliases = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
    return `${marker}${m.id}${aliases} — ${m.label}`;
  }).join("\n");
}
