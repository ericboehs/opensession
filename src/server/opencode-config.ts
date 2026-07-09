/**
 * Config for the OpenCode engine's Anthropic subscription bridge
 * (docs/sandboxes-plan.md, Workstream E item 4).
 *
 * File: ~/.backstage-opencode.json — missing or `enabled: false` means NO
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
 *     "turnTimeoutMinutes": 60,      // optional: hard wall-clock cap per opencode
 *         // turn (opencode-runner aborts past it). Default 60.
 *     "bridgeMaxRequestsPerHour": 300 // optional: per-account rolling request
 *         // ceiling on the NATIVE bridge (429 past it). Default 300.
 *   }
 *
 * Read fresh per call (tiny file) so edits apply without a restart — except
 * `pickerModels`, which models.ts folds into its registry at module load.
 * The env override is a test seam (verify scripts point it at a temp file so
 * they never enable the real bridge).
 */

import { envAlias, stateDir } from "./rename-compat";
import { existsSync, readFileSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";

function configPath(): string {
  return (
    envAlias("OPENSESSION_OPENCODE_CONFIG", "BACKSTAGE_OPENCODE_CONFIG") ||
    stateDir("opencode.json")
  );
}

export type BridgeMode = "meridian" | "native" | "off";

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
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string" && !!x) : undefined;
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

export const DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR = 300;

/** Rolling per-account request ceiling for the native Anthropic bridge. */
export function bridgeMaxRequestsPerHour(): number {
  return (
    readOpencodeBridgeConfig()?.bridgeMaxRequestsPerHour || DEFAULT_BRIDGE_MAX_REQUESTS_PER_HOUR
  );
}

/** Opencode model ids to surface in the UI picker (empty when disabled). */
export function opencodePickerModels(): string[] {
  const cfg = readOpencodeBridgeConfig();
  if (!cfg?.enabled) return [];
  return (cfg.pickerModels || []).filter((id) => id.startsWith("opencode/"));
}
