/**
 * Model registry: which models sessions can run on, and which agent backend
 * ("provider") serves each one. Claude models run through the Claude Agent SDK
 * (claude-runner.ts); GPT/Codex models run through the Codex SDK
 * (codex-runner.ts). The session's `model` field is always stored as the
 * canonical id, never an alias.
 */

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
  { id: "claude-sonnet-4-6", provider: "claude", label: "Claude Sonnet 4.6", aliases: ["sonnet"] },
  { id: "claude-haiku-4-5", provider: "claude", label: "Claude Haiku 4.5", aliases: ["haiku"] },
  { id: "gpt-5.5", provider: "codex", label: "GPT-5.5 (Codex)", aliases: ["codex", "gpt", "gpt5.5"] },
  { id: "gpt-5.4", provider: "codex", label: "GPT-5.4 (Codex)", aliases: ["gpt5.4"] },
  { id: "gpt-5.4-mini", provider: "codex", label: "GPT-5.4 mini (Codex)", aliases: ["mini"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", label: "GPT-5.3 Codex Spark", aliases: ["spark"] },
];

/** Per-provider defaults: claude-fable-5 for Anthropic, gpt-5.5 for OpenAI. */
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";

/** Global default when a session has no model set (same env var as before). */
export const DEFAULT_MODEL = process.env.MICHAEL_MODEL || DEFAULT_CLAUDE_MODEL;

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
  if (!model) return resolveModel(DEFAULT_MODEL)?.provider ?? "claude";
  return resolveModel(model)?.provider ?? "claude";
}

export function modelLabel(model?: string | null): string {
  const id = model || DEFAULT_MODEL;
  return KNOWN_MODELS.find((m) => m.id === id)?.label || id;
}

/** Human list for /model help output. */
export function formatModelList(current?: string | null): string {
  const cur = current || DEFAULT_MODEL;
  return KNOWN_MODELS.map((m) => {
    const marker = m.id === cur ? "→ " : "   ";
    const aliases = m.aliases.length ? ` (${m.aliases.join(", ")})` : "";
    return `${marker}${m.id}${aliases} — ${m.label}`;
  }).join("\n");
}
