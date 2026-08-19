/**
 * The per-model default-engine map. Mirrors pi-config.ts: one tiny JSON file,
 * read fresh per call so edits apply without a restart, raw read-modify-write
 * on the write path so unknown fields survive, atomic rename + 0600.
 *
 * File: ~/.opensession-engines.json. This module used to also gate the two
 * direct-SDK engines (claude-direct, codex-direct); those engines are removed,
 * and any `claude`/`codex` fields still in the file are unknown fields that
 * survive writes untouched. Stale modelEngines entries naming a removed
 * engine are dropped on read.
 *
 * Shape:
 *   {
 *     "modelEngines": { "claude-opus-5": "pi" }
 *         // Per-model default engine, keyed by the BASE model id (never an
 *         // engine-prefixed id). Values are engine ids; entries for unknown
 *         // engines are dropped by normalization. An explicit engine choice
 *         // on the session (an engine-prefixed model id) always wins over
 *         // this map; the map wins over the global default engine.
 *   }
 *
 * Enablement for the engines stays where it lives today: opencode-config.ts
 * and pi-config.ts. This module only owns the model-to-engine defaults.
 */

import { chmodSync, existsSync, readFileSync } from "fs";
import { stateDir } from "../paths";
import { writeJsonAtomic } from "../shared/atomic-write";

/** Engine ids, matching models.ts's Provider union and the UI's
 *  ENGINE_LABELS keys. */
export const ENGINE_IDS = ["opencode", "pi"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export function enginesConfigPath(): string {
  return process.env.OPENSESSION_ENGINES_CONFIG || stateDir("engines.json");
}

export interface EnginesConfig {
  /** Base model id -> default engine for it. */
  modelEngines: Record<string, EngineId>;
}

function isEngineId(x: unknown): x is EngineId {
  return typeof x === "string" && (ENGINE_IDS as readonly string[]).includes(x);
}

/** Pure normalization (exported for tests): raw JSON to typed config.
 *  Tolerant: anything that is not a JSON object normalizes to the empty
 *  config, and modelEngines entries whose value is not a known engine id
 *  (or whose key is engine-prefixed — including the removed direct engines'
 *  claude/ and codex/ prefixes) are dropped. */
export function normalizeEnginesConfig(raw: unknown): EnginesConfig {
  const empty: EnginesConfig = { modelEngines: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;
  const modelEngines: Record<string, EngineId> = {};
  if (r.modelEngines && typeof r.modelEngines === "object" && !Array.isArray(r.modelEngines)) {
    for (const [model, engine] of Object.entries(r.modelEngines as Record<string, unknown>)) {
      // Keys are base ids; an engine-prefixed key would double-route.
      if (!model || /^(?:opencode|pi|claude|codex)\//.test(model)) continue;
      if (isEngineId(engine)) modelEngines[model] = engine;
    }
  }
  return { modelEngines };
}

export function readEnginesConfig(): EnginesConfig {
  const path = enginesConfigPath();
  if (!existsSync(path)) return normalizeEnginesConfig(null);
  try {
    return normalizeEnginesConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    console.warn(`[engines-config] Failed to parse ${path}:`, e);
    return normalizeEnginesConfig(null);
  }
}

/** The configured default engine for a BASE model id, or null when unset.
 *  Callers pass the base id (strip any engine prefix first). */
export function modelEngineDefault(model: string): EngineId | null {
  return readEnginesConfig().modelEngines[model] ?? null;
}

export function modelEngineDefaults(): Record<string, EngineId> {
  return readEnginesConfig().modelEngines;
}

// Write path (Settings). Raw read-modify-write so fields this module does not
// own survive a save; fail loudly on an unparseable existing file rather than
// clobbering it.

function readRawEnginesConfig(): Record<string, unknown> {
  const path = enginesConfigPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Cannot update ${path}: existing content is not a JSON object`);
  }
  return raw as Record<string, unknown>;
}

function writeRawEnginesConfig(raw: Record<string, unknown>): void {
  const path = enginesConfigPath();
  writeJsonAtomic(path, raw);
  chmodSync(path, 0o600);
}

/** Set (engine id) or clear (null) the default engine for a base model id.
 *  Throws on an engine-prefixed model key or an unknown engine id, matching
 *  normalizeEnginesConfig's drop rules so a UI write can never store an entry
 *  the reader would silently discard. */
export function setModelEngineDefault(model: string, engine: EngineId | null): Record<string, EngineId> {
  if (!model || /^(?:opencode|pi|claude|codex)\//.test(model)) {
    throw new Error(`Invalid model key "${model}" (pass the base model id, not an engine-prefixed one)`);
  }
  if (engine !== null && !isEngineId(engine)) {
    throw new Error(`Unknown engine "${engine}" (expected one of ${ENGINE_IDS.join(", ")})`);
  }
  const raw = readRawEnginesConfig();
  const map =
    raw.modelEngines && typeof raw.modelEngines === "object" && !Array.isArray(raw.modelEngines)
      ? { ...(raw.modelEngines as Record<string, unknown>) }
      : {};
  if (engine === null) delete map[model];
  else map[model] = engine;
  raw.modelEngines = map;
  writeRawEnginesConfig(raw);
  return normalizeEnginesConfig(raw).modelEngines;
}
