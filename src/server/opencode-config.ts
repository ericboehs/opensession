/**
 * Config for the OpenCode engine's Anthropic Max-subscription bridge
 * (docs/sandboxes-plan.md, Workstream E item 4).
 *
 * File: ~/.backstage-opencode.json — missing or `enabled: false` means the
 * bridge NEVER starts and `opencode/anthropic/*` models fail with a clear
 * error. The opencode engine itself needs no config: it activates only for
 * models explicitly prefixed `opencode/` (nothing defaults to it).
 *
 * Shape:
 *   {
 *     "enabled": true,
 *     "bridgeAccountIds": ["<claude-accounts id>", ...],  // REQUIRED for the bridge:
 *         // only these designated subscriptions ever serve bridge traffic —
 *         // never the general pool (account-flag risk containment). The
 *         // account must have extra usage enabled at claude.ai/settings/usage:
 *         // Anthropic bills third-party-app traffic on subscription tokens to
 *         // extra-usage credits and 400s without them (see anthropic-bridge.ts).
 *     "port": 3456,                                        // loopback bridge port
 *     "pickerModels": ["opencode/anthropic/claude-sonnet-5"] // optional: surface
 *         // these ids in the UI model picker. Absent = opencode models are
 *         // type-in only (still routable, just not advertised).
 *   }
 *
 * Read fresh per call (tiny file) so edits apply without a restart — except
 * `pickerModels`, which models.ts folds into its registry at module load.
 * The env override is a test seam (verify scripts point it at a temp file so
 * they never enable the real bridge).
 */

import { existsSync, readFileSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";

function configPath(): string {
  return process.env.BACKSTAGE_OPENCODE_CONFIG || `${HOME}/.backstage-opencode.json`;
}

export interface OpencodeBridgeConfig {
  enabled: boolean;
  /** claude-accounts ids allowed to serve bridge traffic. Empty/absent = bridge unusable. */
  bridgeAccountIds?: string[];
  /** Loopback port for the bridge (default 3456). */
  port?: number;
  /** Model ids (opencode/<provider>/<model>) to show in the UI picker. */
  pickerModels?: string[];
}

export function readOpencodeBridgeConfig(): OpencodeBridgeConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    return {
      enabled: raw.enabled === true,
      bridgeAccountIds: Array.isArray(raw.bridgeAccountIds)
        ? raw.bridgeAccountIds.filter((x: unknown) => typeof x === "string" && x)
        : undefined,
      port: typeof raw.port === "number" && raw.port > 0 ? raw.port : undefined,
      pickerModels: Array.isArray(raw.pickerModels)
        ? raw.pickerModels.filter((x: unknown) => typeof x === "string" && x)
        : undefined,
    };
  } catch (e) {
    console.warn(`[opencode-config] Failed to parse ${path}:`, e);
    return null;
  }
}

/** Whether the Anthropic bridge may run at all. */
export function bridgeEnabled(): boolean {
  return readOpencodeBridgeConfig()?.enabled === true;
}

export const DEFAULT_BRIDGE_PORT = 3456;

export function bridgePort(): number {
  return readOpencodeBridgeConfig()?.port || DEFAULT_BRIDGE_PORT;
}

/** Opencode model ids to surface in the UI picker (empty when disabled). */
export function opencodePickerModels(): string[] {
  const cfg = readOpencodeBridgeConfig();
  if (!cfg?.enabled) return [];
  return (cfg.pickerModels || []).filter((id) => id.startsWith("opencode/"));
}
