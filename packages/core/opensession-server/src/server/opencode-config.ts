/**
 * Config for the OpenCode engine's Anthropic subscription bridge
 * (docs/self-hosting-sandboxes.md).
 *
 * File: ~/.opensession-opencode.json (legacy ~/.opensession-opencode.json still read) — missing or `enabled: false` means NO
 * bridge of any kind ever starts and `opencode/anthropic/*` models fail with a
 * clear error. The opencode engine itself needs no config: it activates only
 * for models explicitly prefixed `opencode/` (nothing defaults to it).
 *
 * Shape:
 *   {
 *     "enabled": true,
 *     "bridge": {
 *       "mode": "meridian",        // "meridian" (default when enabled) | "native" | "off"
 *           // meridian: the literal opencode-with-claude/Meridian stack, bundled
 *           //   as pinned npm deps and injected as an OpenCode plugin per session
 *           //   server (see opencode-runner.ts). Runs on flat subscription quota.
 *           // native: our own anthropic-bridge.ts (Agent SDK reimplementation,
 *           //   no fingerprint scrubbing — Anthropic bills it to extra-usage
 *           //   credits and 400s without them; see that module's doc).
 *           // off: opencode/anthropic/* models error.
 *       "accounts": ["<claude-accounts id>", ...]
 *           // Optional in meridian mode: restrict serving accounts to these ids
 *           //   (another user's personal account is still never used). Absent =
 *           //   the normal accounts-layer pick: shared pool accounts + the run
 *           //   user's own personal accounts, personal-first.
 *           // REQUIRED for native mode: only these designated subscriptions
 *           //   ever serve native-bridge traffic — never the general pool —
 *           //   and they need extra usage enabled at claude.ai/settings/usage.
 *       "openaiAccounts": ["<codex-accounts id>", ...]
 *           // Optional: restrict which codex accounts serve opencode/openai/*
 *           //   runs, in preference order. Absent = the normal codex pool pick.
 *           //   Independent of `enabled` — opencode/openai keys off the codex
 *           //   accounts pool (ChatGPT-subscription auth), see
 *           //   opencode-openai-auth.ts.
 *     },
 *     "bridgeAccountIds": ["..."],  // LEGACY alias for bridge.accounts (used
 *         // only when bridge.accounts is absent); kept so existing configs and
 *         // anthropic-bridge.ts (which reads the normalized bridgeAccountIds)
 *         // work unchanged.
 *     "port": 3456,                 // loopback port for the NATIVE bridge only
 *         // (meridian always picks an ephemeral loopback port per server)
 *     "pickerModels": ["opencode/anthropic/claude-sonnet-5"], // optional: surface
 *         // these ids in the UI model picker. Absent = opencode models are
 *         // type-in only (still routable, just not advertised).
 *     "providers": { "xai": { "apiKey": "...", "baseURL": "..." } },
 *         // optional: third-party model providers (any provider opencode
 *         //   supports — xai, openrouter, groq, …) with their API keys.
 *         //   Injected into the OpenCode config as provider.<id>.options.
 *         //   anthropic/openai are NEVER configured here: they run on the
 *         //   subscription bridges above and always override this map.
 *     "turnTimeoutMinutes": 60,      // optional: hard wall-clock cap per opencode
 *         // turn (opencode-runner aborts past it). Default 60.
 *     "bridgeMaxRequestsPerHour": 300, // optional: per-account rolling request
 *         // ceiling on the NATIVE bridge (429 past it). Default 300.
 *     "orchestrator": true           // optional: surface The Orchestrator presets
 *         // (models.ts ORCHESTRATOR_PRESETS) in the model picker. Off by
 *         // default; OPENSESSION_ORCHESTRATOR=1 also enables. Stored preset
 *         // ids keep resolving either way — this only gates the picker.
 *   }
 *
 * Read fresh per call (tiny file) so edits apply without a restart — except
 * `pickerModels`, which models.ts folds into its registry at module load (the
 * model-providers settings routes call refreshOpencodePickerModels() after
 * writing, so UI edits show up without one). The env override is a test seam
 * (verify scripts point it at a temp file so they never enable the real
 * bridge).
 *
 * `providers` and `pickerModels` are also WRITTEN here (Settings → Model
 * providers): raw-JSON read-modify-write so unknown/legacy fields survive,
 * atomic rename + chmod 0600 because the file holds API keys.
 */

import { homeDir } from "./paths";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { chmodSync, existsSync, readFileSync } from "fs";

const HOME = homeDir();

/** Bridge-config file path (exported for the state-path regression test). */
export function configPath(): string {
  return (
    process.env.OPENSESSION_OPENCODE_CONFIG ||
    stateDir("opencode.json")
  );
}

export type BridgeMode = "meridian" | "native" | "off";

/** One configured third-party provider (xai, openrouter, groq, …). */
export interface OpencodeProviderConfig {
  apiKey?: string;
  baseURL?: string;
}

/** Cerebras' public, open-weight model catalog. Kept here so adding a key in
 * Settings is enough to make the provider useful. models.dev has since grown a
 * native cerebras entry (@ai-sdk/cerebras), but we keep the explicit
 * OpenAI-compatible injection: it carries the `interleaved` reasoning-echo
 * field the native catalog lacks, plus our variant/limit tuning. */
export const CEREBRAS_PICKER_MODELS = [
  "gpt-oss-120b",
  "gemma-4-31b",
  "zai-glm-4.7",
] as const;

/** The reasoning levels Wafer's `reasoning_effort` accepts (docs.wafer.ai
 *  /serverless/api-reference). A subset of models.ts' SessionEffort, spelled
 *  out here so this module stays free of an import back into the registry. */
export type WaferEffort = "low" | "medium" | "high" | "max";

/** Wafer normalizes reasoning effort at its own edge rather than passing the
 *  upstream model's levels through, so one ladder serves the whole catalog —
 *  verified on the wire against every model here, including the DeepSeek and
 *  Kimi routes whose upstream catalogs list only low/high/max. `none` is
 *  omitted deliberately: it means "don't think", and these are coding models. */
const WAFER_EFFORTS: readonly WaferEffort[] = ["low", "medium", "high", "max"];

/** Wafer's catalog (docs.wafer.ai/wafer-pass) — one entry per `model` string
 * the OpenAI-compatible endpoint serves. Held here for the same reason as
 * Cerebras above: adding a key in Settings should be enough to make the
 * provider useful. models.dev does carry a `wafer.ai` provider, but its
 * catalog is missing the Kimi K3 and DeepSeek tiers, and the dot in its id is
 * not a legal provider slug for us (PROVIDER_ID_RE) — so the models are
 * injected explicitly under the plain `wafer` id instead.
 *
 * Every model gets the WAFER_EFFORTS variants above, which is also what turns
 * thinking on: Wafer serves every model with reasoning OFF until a request
 * carries an effort.
 *
 * The ids are LOWERCASE, unlike the mixed-case strings Wafer's own docs and
 * catalog print ("DeepSeek-V4-Flash-0731-Fast"). Model ids are case-insensitive
 * here and resolveModel() canonicalizes every one to lowercase, so a mixed-case
 * id reaches OpenCode lowercased and fails its case-SENSITIVE model lookup
 * ("Model not found: wafer/deepseek-v4-flash-0731-fast. Did you mean …?").
 * Wafer documents its own model names as case-insensitive, so the lowercase
 * form is what both ends accept. `name` carries the display casing. */
const WAFER_MODELS: Record<
  string,
  {
    name: string;
    context: number;
    output: number;
    cost: { input: number; output: number; cache_read: number };
    /** Only where Wafer documents vision input; text-only otherwise. */
    attachment?: boolean;
    /** Wafer strips sampling params on the Moonshot-routed models. */
    temperature?: boolean;
  }
> = {
  "deepseek-v4-flash-0731-fast": {
    name: "DeepSeek V4 Flash",
    context: 1_048_576,
    output: 384_000,
    cost: { input: 0.28, output: 0.56, cache_read: 0.07 },
  },
  "glm-5.2": {
    name: "GLM-5.2",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 1.26, output: 3.96, cache_read: 0.23 },
  },
  "glm5.2-fast": {
    name: "GLM-5.2 Fast",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 2.1, output: 6.6, cache_read: 0.21 },
  },
  "glm-5.1": {
    name: "GLM-5.1",
    context: 202_752,
    output: 131_072,
    cost: { input: 1.0, output: 3.2, cache_read: 0.1 },
  },
  "kimi-k3": {
    name: "Kimi K3",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 3.0, output: 15.0, cache_read: 0.3 },
    attachment: true,
    temperature: false,
  },
  "kimi-k3-fast": {
    name: "Kimi K3 Fast",
    context: 1_048_576,
    output: 131_072,
    cost: { input: 4.5, output: 22.5, cache_read: 0.45 },
    attachment: true,
    temperature: false,
  },
  "kimi-k2.6": {
    name: "Kimi K2.6",
    context: 262_144,
    output: 65_536,
    cost: { input: 1.14, output: 4.8, cache_read: 0.19 },
    attachment: true,
    temperature: false,
  },
};

/** Wafer's model ids, in picker order. */
export const WAFER_PICKER_MODELS: readonly string[] = Object.keys(WAFER_MODELS);

/** Wafer treats model names as case-insensitive, so a hand-typed id resolves
 *  to the same entry the picker uses. Undefined when it isn't a Wafer model. */
function waferModel(model: string) {
  const id = Object.keys(WAFER_MODELS).find(
    (known) => known.toLowerCase() === model.toLowerCase()
  );
  return id ? WAFER_MODELS[id] : undefined;
}

/** The reasoning ladder for a Wafer model (empty when it isn't one). */
export function waferModelEfforts(model: string): readonly WaferEffort[] {
  return waferModel(model) ? WAFER_EFFORTS : [];
}

/** Display name for a Wafer model ("" when it isn't one) — the slugs carry
 *  version and tier segments that the generic prettifier mangles. */
export function waferModelName(model: string): string {
  return waferModel(model)?.name || "";
}

export function defaultPickerModelsForProvider(id: string): readonly string[] {
  if (id === "cerebras") return CEREBRAS_PICKER_MODELS;
  if (id === "wafer") return WAFER_PICKER_MODELS;
  return [];
}

/** A self-catalogued provider shaped for the Pi engine's registerProvider:
 *  the API dialect, endpoint and per-model metadata pi needs to serve a
 *  provider absent from its built-in catalog. One source of truth with the
 *  OpenCode injection above (opencodeProviderOptions' wafer arm) — the same
 *  WAFER_MODELS table, expressed as pi-ai model entries. Cerebras needs no
 *  entry here: pi's built-in catalog already carries it. */
export interface PiProviderCatalog {
  name: string;
  api: "openai-completions";
  baseUrl: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevelMap: Record<string, string>;
    input: Array<"text" | "image">;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }>;
}

export function piProviderCatalog(id: string): PiProviderCatalog | undefined {
  if (id !== "wafer") return undefined;
  return {
    name: "Wafer",
    api: "openai-completions",
    baseUrl: "https://pass.wafer.ai/v1",
    models: Object.entries(WAFER_MODELS).map(([modelId, m]) => ({
      id: modelId,
      name: m.name,
      reasoning: true,
      // Pi's six-rung ladder onto Wafer's four (WAFER_EFFORTS): pi-ai falls
      // back to the raw level for unmapped rungs, so only the two off-ladder
      // ones need entries. This is also the thinking switch — Wafer serves
      // reasoning OFF until a request carries an effort, same as on OpenCode.
      thinkingLevelMap: { minimal: "low", xhigh: "max" },
      input: m.attachment ? ["text", "image"] : ["text"],
      cost: {
        input: m.cost.input,
        output: m.cost.output,
        cacheRead: m.cost.cache_read,
        cacheWrite: 0,
      },
      contextWindow: m.context,
      maxTokens: m.output,
    })),
  };
}

/** Valid provider ids — matches opencode's own provider slugs. */
export const PROVIDER_ID_RE = /^[a-z0-9-]+$/;

/** Providers served by the subscription bridges — never raw API keys here. */
export const BRIDGE_PROVIDER_IDS = new Set(["anthropic", "openai"]);

export interface OpencodeBridgeConfig {
  enabled: boolean;
  /** How opencode/anthropic/* models are served. Normalized: "off" whenever
   *  `enabled` is false; otherwise bridge.mode, defaulting to "meridian". */
  bridgeMode: BridgeMode;
  /** Account restriction, normalized from bridge.accounts (falling back to the
   *  legacy top-level bridgeAccountIds). Semantics differ by mode — meridian:
   *  optional restriction; native: required designated set (never the pool). */
  bridgeAccountIds?: string[];
  /** Loopback port for the native bridge (default 3456). */
  port?: number;
  /** Model ids (opencode/<provider>/<model>) to show in the UI picker. */
  pickerModels?: string[];
  /** Hard wall-clock cap per opencode turn, minutes (default 60). */
  turnTimeoutMinutes?: number;
  /** Per-account rolling request ceiling on the native bridge (default 300/h). */
  bridgeMaxRequestsPerHour?: number;
  /** Optional restriction of which codex accounts (codex-accounts.ts ids) serve
   *  opencode/openai/* runs, in preference order (read from bridge.openaiAccounts).
   *  Absent = the normal codex pool pick. Independent of `enabled` (that flag
   *  only gates the Anthropic bridge); opencode/openai auth keys off the codex
   *  accounts pool, not this file — see opencode-openai-auth.ts. */
  openaiAccounts?: string[];
  /** Third-party providers (id → apiKey/baseURL), injected into OpenCode
   *  config as provider.<id>.options. Independent of `enabled` (that flag only
   *  gates the Anthropic bridge). anthropic/openai never live here. */
  providers?: Record<string, OpencodeProviderConfig>;
  /** Opt-in: surface The Orchestrator presets in the model picker. */
  orchestrator?: boolean;
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string" && !!x) : undefined;
}

function providerMap(v: unknown): Record<string, OpencodeProviderConfig> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, OpencodeProviderConfig> = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!PROVIDER_ID_RE.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    out[id] = {
      ...(typeof r.apiKey === "string" && r.apiKey ? { apiKey: r.apiKey } : {}),
      ...(typeof r.baseURL === "string" && r.baseURL ? { baseURL: r.baseURL } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Pure normalization (exported for tests): raw JSON → typed config. */
export function normalizeOpencodeConfig(raw: unknown): OpencodeBridgeConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === true;
  const bridge =
    r.bridge && typeof r.bridge === "object" && !Array.isArray(r.bridge)
      ? (r.bridge as Record<string, unknown>)
      : undefined;
  const bridgeMode: BridgeMode = !enabled
    ? "off"
    : bridge?.mode === "native"
      ? "native"
      : bridge?.mode === "off"
        ? "off"
        : "meridian";
  return {
    enabled,
    bridgeMode,
    bridgeAccountIds: stringArray(bridge?.accounts) ?? stringArray(r.bridgeAccountIds),
    port: typeof r.port === "number" && r.port > 0 ? r.port : undefined,
    pickerModels: stringArray(r.pickerModels),
    turnTimeoutMinutes:
      typeof r.turnTimeoutMinutes === "number" && r.turnTimeoutMinutes > 0
        ? r.turnTimeoutMinutes
        : undefined,
    bridgeMaxRequestsPerHour:
      typeof r.bridgeMaxRequestsPerHour === "number" && r.bridgeMaxRequestsPerHour > 0
        ? r.bridgeMaxRequestsPerHour
        : undefined,
    openaiAccounts: stringArray(bridge?.openaiAccounts),
    providers: providerMap(r.providers),
    orchestrator: r.orchestrator === true,
  };
}

export function readOpencodeBridgeConfig(): OpencodeBridgeConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return normalizeOpencodeConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.warn(`[opencode-config] Failed to parse ${path}:`, e);
    return null;
  }
}

/** Whether any Anthropic bridge may run at all. */
export function bridgeEnabled(): boolean {
  return readOpencodeBridgeConfig()?.enabled === true;
}

export const DEFAULT_BRIDGE_PORT = 3456;

export function bridgePort(): number {
  return readOpencodeBridgeConfig()?.port || DEFAULT_BRIDGE_PORT;
}

export const DEFAULT_TURN_TIMEOUT_MINUTES = 60;

/** Per-turn wall-clock cap for the opencode runner, in ms. Applies regardless
 *  of `enabled` (that flag only gates the Anthropic bridge). */
export function opencodeTurnTimeoutMs(): number {
  const mins = readOpencodeBridgeConfig()?.turnTimeoutMinutes || DEFAULT_TURN_TIMEOUT_MINUTES;
  return mins * 60_000;
}

/** "3 hours" / "90 minutes" — the limit as a person would say it. */
function turnLimitLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins % 60 !== 0) return `${mins} minutes`;
  const hours = mins / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/* Both cutoff messages live here, next to the setting they describe, because
 * the deadline fires from two places (a fresh turn and a reattached one) and
 * the two copies had already drifted apart in wording. They speak to whoever
 * opens the session, not to whoever configured it: the turn is over, the work
 * is safe, here's how to carry on. `turnTimeoutMinutes` is documented in this
 * module rather than recited in the message. */

/** Durable transcript line when a turn is cut off at its deadline. */
export function turnTimeoutNotice(ms = opencodeTurnTimeoutMs()): string {
  return (
    `Stopped after ${turnLimitLabel(ms)}, the limit for a single turn. ` +
    "Everything up to here is saved; send a message to continue."
  );
}

/** The same cutoff as a run failure (session list, header banner, Slack). */
export function turnTimeoutError(ms = opencodeTurnTimeoutMs()): string {
  return `Stopped after ${turnLimitLabel(ms)}, the limit for a single turn.`;
}

/* The tool-stall cutoff messages live here for the same reason as the
 * turn-timeout pair above: the guard fires from both the fresh-turn and the
 * reattached-turn paths. `label` is the hung call as the transcript shows it
 * (tool name + input excerpt, e.g. `bash: setsid -f google-chrome …`). */

/** Durable transcript line when a turn is cut off on a hung tool call. */
export function toolStallNotice(label: string, quietMs: number): string {
  return (
    `Stopped this turn: a tool call (${label}) produced no output for ` +
    `${turnLimitLabel(quietMs)} and looks hung. Everything up to here is saved; ` +
    "send a message to continue. If the call started a background process " +
    "(setsid, nohup, &), note that a detached child inheriting the tool's " +
    "stdout/stderr keeps the call open forever — relaunch it with " +
    "`</dev/null >/tmp/<name>.log 2>&1`."
  );
}

/** The same tool-stall cutoff as a run failure (session list, header banner). */
export function toolStallError(label: string, quietMs: number): string {
  return `Stopped: a tool call (${label}) produced no output for ${turnLimitLabel(quietMs)} and looks hung.`;
}

export const DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR = 300;

/** Rolling per-account request ceiling for the native Anthropic bridge. */
export function bridgeMaxRequestsPerHour(): number {
  return (
    readOpencodeBridgeConfig()?.bridgeMaxRequestsPerHour || DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR
  );
}

/** The Orchestrator presets are opt-in (off by default): `"orchestrator": true`
 *  in the config file, or OPENSESSION_ORCHESTRATOR=1. Gates only the picker —
 *  stored orchestrator/<name> session ids resolve and run regardless. */
export function opencodeOrchestratorEnabled(): boolean {
  if (process.env.OPENSESSION_ORCHESTRATOR === "1") return true;
  return readOpencodeBridgeConfig()?.orchestrator === true;
}

/** Opencode model ids to surface in the UI picker (empty when disabled). */
export function opencodePickerModels(): string[] {
  const cfg = readOpencodeBridgeConfig();
  if (!cfg?.enabled) return [];
  return (cfg.pickerModels || []).filter((id) => id.startsWith("opencode/"));
}

// ── Write path (Settings → Model providers) ─────────────────────────────────
//
// Raw-JSON read-modify-write: the normalized shape above drops/renames fields
// (bridge, legacy aliases), so writes always go through the raw object to
// preserve everything we don't own. Atomic rename + 0600 — the file holds keys.

function readRawOpencodeConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  // Unlike the read path (fail-soft null), a write built on `{}` would clobber
  // a config that's merely unparseable — fail loudly instead.
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Cannot update ${path}: existing content is not a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function writeRawOpencodeConfig(raw: Record<string, unknown>): void {
  const path = configPath();
  writeJsonAtomic(path, raw);
  chmodSync(path, 0o600);
}

function rawProviders(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.providers && typeof raw.providers === "object" && !Array.isArray(raw.providers)
    ? (raw.providers as Record<string, unknown>)
    : {};
}

function rawPickerModels(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.pickerModels)
    ? raw.pickerModels.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : [];
}

/**
 * Turn the engine config on or off. This is the flag that gates the whole
 * `opencode/` model surface: the Anthropic bridge, and (via
 * `opencodePickerModels`) whether third-party provider models reach the picker
 * at all. Nothing used to write it, so a fresh install had it absent — every
 * Anthropic turn failed pointing at a file no code path created, and
 * UI-configured providers never showed up. Onboarding seeds it, and Settings →
 * Setup toggles it; both land here.
 */
export function setBridgeEnabled(enabled: boolean): void {
  const raw = readRawOpencodeConfig();
  raw.enabled = enabled;
  writeRawOpencodeConfig(raw);
}

/** Configured third-party providers (id → apiKey/baseURL). Read fresh. */
export function opencodeProviders(): Record<string, OpencodeProviderConfig> {
  return readOpencodeBridgeConfig()?.providers || {};
}

/**
 * Upsert a third-party provider. Field semantics: `undefined` keeps the stored
 * value, `""` clears it, anything else replaces it. Throws on invalid ids and
 * on the bridge providers (anthropic/openai run on subscriptions, not keys).
 */
export function setOpencodeProvider(id: string, cfg: OpencodeProviderConfig): void {
  if (!PROVIDER_ID_RE.test(id)) {
    throw new Error(`Invalid provider id "${id}" (lowercase letters, digits and dashes only)`);
  }
  if (BRIDGE_PROVIDER_IDS.has(id)) {
    throw new Error(`"${id}" runs on the subscription bridge, not a raw API key`);
  }
  const raw = readRawOpencodeConfig();
  const providers = rawProviders(raw);
  const existing =
    providers[id] && typeof providers[id] === "object" && !Array.isArray(providers[id])
      ? (providers[id] as Record<string, unknown>)
      : {};
  const next: OpencodeProviderConfig = {
    ...(typeof existing.apiKey === "string" && existing.apiKey ? { apiKey: existing.apiKey } : {}),
    ...(typeof existing.baseURL === "string" && existing.baseURL ? { baseURL: existing.baseURL } : {}),
  };
  if (cfg.apiKey !== undefined) {
    if (cfg.apiKey) next.apiKey = cfg.apiKey;
    else delete next.apiKey;
  }
  if (cfg.baseURL !== undefined) {
    if (cfg.baseURL) next.baseURL = cfg.baseURL;
    else delete next.baseURL;
  }
  providers[id] = next;
  raw.providers = providers;
  writeRawOpencodeConfig(raw);
}

/** Remove a third-party provider. Returns whether it existed. */
export function removeOpencodeProvider(id: string): boolean {
  const raw = readRawOpencodeConfig();
  const providers = rawProviders(raw);
  if (!(id in providers)) return false;
  delete providers[id];
  if (Object.keys(providers).length) raw.providers = providers;
  else delete raw.providers;
  writeRawOpencodeConfig(raw);
  return true;
}

/**
 * The configured providers shaped for OpenCode config injection:
 * `{ [id]: { options: { apiKey, baseURL? } } }`. The runners spread this UNDER
 * their bridge providerOverride so anthropic/openai always win; belt-and-
 * suspenders, bridge provider ids are skipped here too.
 */
export function opencodeProviderOptions(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, p] of Object.entries(opencodeProviders())) {
    if (BRIDGE_PROVIDER_IDS.has(id)) continue;
    const options: Record<string, string> = {
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
    };
    if (!Object.keys(options).length) continue;
    if (id === "wafer") {
      out[id] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Wafer",
        options: { ...options, baseURL: p.baseURL || "https://pass.wafer.ai/v1" },
        models: Object.fromEntries(
          Object.entries(WAFER_MODELS).map(([modelId, m]) => [
            modelId,
            {
              name: m.name,
              reasoning: true,
              // Wafer returns the chain of thought in `reasoning_content` on
              // every reasoning-capable model, which is also the
              // openai-compatible default — stated here so the contract is
              // visible next to the models it applies to.
              interleaved: { field: "reasoning_content" },
              tool_call: true,
              ...(m.attachment ? { attachment: true } : {}),
              ...(m.temperature === false ? { temperature: false } : {}),
              limit: { context: m.context, output: m.output },
              cost: m.cost,
              variants: Object.fromEntries(
                WAFER_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }])
              ),
            },
          ])
        ),
      };
    } else if (id === "cerebras") {
      out[id] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Cerebras",
        options: { ...options, baseURL: p.baseURL || "https://api.cerebras.ai/v1" },
        models: {
          "gpt-oss-120b": {
            name: "GPT OSS 120B",
            reasoning: true,
            // Cerebras rejects the openai-compatible default `reasoning_content`
            // on assistant history messages (400 Bad Request on every second
            // turn) but accepts `reasoning` — route the echo through that field.
            interleaved: { field: "reasoning" },
            tool_call: true,
            limit: { context: 131_072, output: 8_192 },
            variants: {
              low: { reasoningEffort: "low" },
              medium: { reasoningEffort: "medium" },
              high: { reasoningEffort: "high" },
            },
          },
          "gemma-4-31b": {
            name: "Gemma 4 31B",
            tool_call: true,
            limit: { context: 131_072, output: 8_192 },
          },
          "zai-glm-4.7": {
            name: "Z.ai GLM-4.7",
            reasoning: true,
            interleaved: { field: "reasoning" },
            tool_call: true,
            limit: { context: 131_072, output: 8_192 },
          },
        },
      };
    } else {
      out[id] = { options };
    }
  }
  return out;
}

/** Add an id to pickerModels (idempotent). Returns the stored list. */
export function addPickerModel(id: string): string[] {
  const raw = readRawOpencodeConfig();
  const list = rawPickerModels(raw);
  if (!list.includes(id)) list.push(id);
  raw.pickerModels = list;
  writeRawOpencodeConfig(raw);
  return list;
}

/** Remove an id from pickerModels. Returns the stored list. */
export function removePickerModel(id: string): string[] {
  const raw = readRawOpencodeConfig();
  const list = rawPickerModels(raw).filter((x) => x !== id);
  raw.pickerModels = list;
  writeRawOpencodeConfig(raw);
  return list;
}

/** Masked display form of a stored key ("sk-x…wxyz") — the full value never
 *  leaves the server. */
export function maskProviderKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
