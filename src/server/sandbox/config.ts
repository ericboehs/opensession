/**
 * Sandbox configuration (Phase 0 of docs/sandboxes-plan.md).
 *
 * `~/.backstage-sandbox.json` picks the provider, e.g.
 *   {"provider": "docker", "image": "backstage-runner:latest",
 *    "idleStopMinutes": 30, "perRepo": {"tella-fusion": {"provider": "docker"}}}
 *
 * Read fresh on every call (same pattern as codexTransport() reading
 * ~/.backstage-codex-transport.json) so a config flip applies to the next run
 * without a restart. Missing/invalid config = provider "local" = exactly
 * today's behavior.
 *
 * Kill switch: `touch ~/.backstage-chats/disable-sandboxes` forces "local" for
 * new runs regardless of config — mirroring host-client's disable-run-hosts.
 */

import { existsSync, readFileSync } from "fs";
import { BACKSTAGE_CHATS_DIR } from "../paths";
import type { SandboxProviderId } from "./provider";

const HOME = process.env.HOME || "/home/ubuntu";
// Env-overridable so the verify suite can point a scratch config at a scratch
// docker setup without touching the live file (which is read fresh per run).
const CONFIG_PATH =
  process.env.BACKSTAGE_SANDBOX_CONFIG || `${HOME}/.backstage-sandbox.json`;
const DISABLE_FILE = `${BACKSTAGE_CHATS_DIR}/disable-sandboxes`;

export interface SandboxRepoOverride {
  provider?: SandboxProviderId;
  image?: string;
}

/** Where a docker sandbox's workspace lives (docs/sandboxes-plan.md Phase 2):
 *  "bind" (default) bind-mounts the existing host worktree at its identical
 *  path; "volume" clones the repo into a per-session volume INSIDE the
 *  container — no host worktree at all, so destroy() deletes the workspace
 *  (that data loss is the mode's contract; push your work). */
export type SandboxWorkspaceMode = "bind" | "volume";

export interface SandboxConfig {
  provider: SandboxProviderId;
  /** Container image for the docker provider (Phase 1). */
  image?: string;
  /** Stop idle sandboxes after this many minutes; unset = provider default (30). */
  idleStopMinutes?: number;
  /** CPU limit per container (docker --cpus); unset = provider default (4). */
  cpus?: number;
  /** Memory limit per container (docker --memory, e.g. "8g"); unset = default ("8g"). */
  memory?: string;
  /** Workspace mode for NEW docker sandboxes (existing sandboxes keep the mode
   *  they were created with — recorded in their state file). Default "bind". */
  workspace?: SandboxWorkspaceMode;
  /** Container ports to publish for previews (docker -p 127.0.0.1::<port>,
   *  random loopback host port, set at container create). Default none. */
  previewPorts?: number[];
  /** Allow startPreview to launch the dev-server bring-up INSIDE the sandbox
   *  (requires the image to carry the repo's dev toolchain). Default false:
   *  only the port-mapping + Caddy layer is active. */
  devServerInSandbox?: boolean;
  /** Per-repo overrides keyed by repo id (worktree.ts REPOS). */
  perRepo?: Record<string, SandboxRepoOverride>;
}

const PROVIDER_IDS = new Set<string>(["local", "docker", "daytona", "e2b"]);

function asProviderId(v: unknown): SandboxProviderId | undefined {
  return typeof v === "string" && PROVIDER_IDS.has(v)
    ? (v as SandboxProviderId)
    : undefined;
}

/** False while the kill-switch file exists — new runs must stay local. */
export function sandboxesEnabled(): boolean {
  return !existsSync(DISABLE_FILE);
}

/** Current config, read fresh per call. Never throws; falls back to local. */
export function sandboxConfig(): SandboxConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const perRepo: Record<string, SandboxRepoOverride> = {};
      if (raw?.perRepo && typeof raw.perRepo === "object") {
        for (const [repoId, o] of Object.entries<any>(raw.perRepo)) {
          const provider = asProviderId(o?.provider);
          const image = typeof o?.image === "string" ? o.image : undefined;
          if (provider || image) perRepo[repoId] = { provider, image };
        }
      }
      const previewPorts = Array.isArray(raw?.previewPorts)
        ? raw.previewPorts.filter(
            (p: unknown): p is number =>
              typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536,
          )
        : [];
      return {
        provider: asProviderId(raw?.provider) || "local",
        image: typeof raw?.image === "string" ? raw.image : undefined,
        idleStopMinutes:
          typeof raw?.idleStopMinutes === "number" && raw.idleStopMinutes > 0
            ? raw.idleStopMinutes
            : undefined,
        cpus: typeof raw?.cpus === "number" && raw.cpus > 0 ? raw.cpus : undefined,
        memory:
          typeof raw?.memory === "string" && /^\d+(\.\d+)?[kmg]b?$/i.test(raw.memory.trim())
            ? raw.memory.trim()
            : undefined,
        workspace: raw?.workspace === "volume" ? "volume" : undefined,
        previewPorts: previewPorts.length ? previewPorts : undefined,
        devServerInSandbox: raw?.devServerInSandbox === true || undefined,
        perRepo: Object.keys(perRepo).length ? perRepo : undefined,
      };
    }
  } catch {}
  return { provider: "local" };
}

/**
 * Effective provider id for a session in `repoId`, honoring the kill switch
 * and per-repo overrides. Missing config, disabled sandboxes, or garbage in
 * the file all resolve to "local".
 */
export function effectiveSandboxProvider(repoId?: string): SandboxProviderId {
  if (!sandboxesEnabled()) return "local";
  const cfg = sandboxConfig();
  return (repoId && cfg.perRepo?.[repoId]?.provider) || cfg.provider || "local";
}
