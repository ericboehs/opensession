/**
 * Sandbox configuration (Phase 0 of docs/sandboxes-plan.md).
 *
 * `~/.opensession-sandbox.json` (dual-read fallback to `~/.backstage-sandbox.json`)
 * picks the provider, e.g.
 *   {"provider": "docker", "image": "backstage-runner:latest",
 *    "idleStopMinutes": 30, "perRepo": {"tella-fusion": {"provider": "docker"}}}
 *
 * Read fresh on every call (same pattern as codexTransport() reading
 * ~/.opensession-codex-transport.json) so a config flip applies to the next run
 * without a restart. Missing/invalid config = provider "local" = exactly
 * today's behavior.
 *
 * Kill switch: `touch <chats-dir>/disable-sandboxes` forces "local" for
 * new runs regardless of config — mirroring host-client's disable-run-hosts.
 */

import { existsSync, readFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "../paths";
import { envAlias, stateDir } from "../rename-compat";
import type { SandboxProviderId } from "./provider";

const HOME = process.env.HOME || "/home/ubuntu";
// Env-overridable so the verify suite (and unit tests) can point a scratch
// config at a scratch docker setup without touching the live file (which is
// read fresh per run). Read per call, not at module load, so a test can flip
// the env var without re-importing this module.
function configPath(): string {
  return (
    envAlias("OPENSESSION_SANDBOX_CONFIG", "BACKSTAGE_SANDBOX_CONFIG") ||
    stateDir("sandbox.json")
  );
}
const DISABLE_FILE = `${OPENSESSION_CHATS_DIR}/disable-sandboxes`;

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

/** How a sandboxed run's host process talks to backstage (Phase 3):
 *  "socket" (default) = unix socket in a shared run dir (docker bind mounts
 *  it); "ws" = the host DIALS OUT to backstage's /backstage/run-ws route —
 *  required for remote providers (daytona/e2b force it), dogfooded by docker. */
export type SandboxTransport = "socket" | "ws";

/** How remote providers authenticate `git clone` inside the sandbox (they
 *  can't mount host creds). "none" = public clone; "https-token" injects the
 *  token into the https URL (GitHub PAT / x-access-token). */
export interface SandboxCloneCredential {
  type: "none" | "https-token";
  token?: string;
}

/** Snapshot-based warm restores for the docker provider (background-agents
 *  pattern, adapted): on idle-stop the container is `docker commit`ed to a
 *  per-session image, and a later ensure() for a GONE container starts from
 *  that image instead of the base one — preserving container-layer state
 *  (installed deps/apt/global caches), NOT workspace or engine state (those
 *  live on volumes/bind mounts). See docker.ts's "Snapshots" header section. */
export interface SandboxSnapshotsConfig {
  /** Master switch. Default false — no snapshot is ever taken or restored. */
  enabled: boolean;
  /** Snapshot on the idle-stop sweep, right before the container stops. Default true. */
  onIdle: boolean;
  /** Keep at most this many snapshot images per session (older ones deleted). Default 2. */
  maxPerSession: number;
  /** After restoring a volume-mode workspace from a snapshot, freshen refs with
   *  a non-destructive `git fetch origin` + `git status` inside. Default true. */
  quickSyncOnRestore: boolean;
}

export const SNAPSHOT_DEFAULTS: SandboxSnapshotsConfig = {
  enabled: false,
  onIdle: true,
  maxPerSession: 2,
  quickSyncOnRestore: true,
};

/** The isolated public dial-back listener (src/server/public-ingress.ts):
 *  a SECOND Bun.serve that exposes ONLY the run-ws/rpc-ws upgrade routes (+ a
 *  bare health check) so remote sandboxes on the public internet can dial
 *  back without the rest of the app ever being reachable. Front it with a
 *  TLS terminator (Caddy/tunnel) — it binds loopback by default. */
export interface SandboxPublicIngressConfig {
  /** Master switch. The listener only starts (at boot — needs a restart) when true. */
  enabled: boolean;
  /** Listen port (default 3860). */
  port: number;
  /** Bind host (default "127.0.0.1" — a reverse proxy/tunnel fronts it). */
  host: string;
  /** The base URL remote sandboxes dial, e.g. "wss://michael.tella.dev"
   *  (http(s) is normalized to ws(s)). When set, remote-provider launches use
   *  it as their callback base instead of callbackBaseUrl. */
  publicBaseUrl?: string;
}

export const PUBLIC_INGRESS_DEFAULT_PORT = 3860;

/** Warm-on-typing prewarm pool for REMOTE providers (src/server/sandbox/
 *  prewarm.ts): typing a new-session prompt with daytona/e2b selected starts
 *  the runner bootstrap immediately; session create adopts the warmed
 *  sandbox. `enabled` defaults to TRUE whenever a remote provider is
 *  configured (the pool is inert otherwise). */
export interface SandboxPrewarmConfig {
  enabled: boolean;
  /** Destroy an untouched prewarm after this many minutes (default 10). */
  ttlMinutes: number;
  /** At most this many live prewarms across all keys (default 2 — paid compute). */
  maxLive: number;
}

export const PREWARM_DEFAULTS: Omit<SandboxPrewarmConfig, "enabled"> = {
  ttlMinutes: 10,
  maxLive: 2,
};

export interface SandboxDaytonaConfig {
  /** Falls back to DAYTONA_API_KEY. */
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /**
   * Org snapshot to create sandboxes from (custom `resources` are rejected
   * when creating from a snapshot, so sizing lives in the snapshot itself).
   * Unset = Daytona's default snapshot: 1 vCPU / 1GB / 3GiB disk — too small
   * for real repo workspaces (the runner payload alone is ~2GB; a tella-fusion
   * clone died on ENOSPC, 2026-07-09). Create one via the SDK, e.g. name
   * backstage-lg-us, image daytonaio/sandbox:0.8.0, resources {cpu:2,
   * memory:4, disk:10 (org max)}, regionId "us".
   */
  snapshot?: string;
}

export interface SandboxE2bConfig {
  /** Falls back to E2B_API_KEY. */
  apiKey?: string;
  /** Sandbox template id/name (default "base"). */
  template?: string;
}

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
  /** Snapshot-based warm restores (docker provider only). Absent = disabled. */
  snapshots?: SandboxSnapshotsConfig;
  /** Per-repo overrides keyed by repo id (worktree.ts REPOS). */
  perRepo?: Record<string, SandboxRepoOverride>;
  /** Run-stream + MCP-RPC transport for NEW sandbox launches. Default "socket".
   *  Remote providers always use "ws" regardless of this value. */
  transport?: SandboxTransport;
  /**
   * Base URL sandboxes dial back to for the WS transport, e.g.
   * "ws://100.65.135.7:3850" (or https://… — normalized to wss). Default is
   * derived from the server's bind (HOST:PORT env). MUST be reachable FROM the
   * sandbox: for remote providers that means a publicly/tailnet-reachable URL
   * (self-hosters: your Tailscale ts.net URL or a tunnel); a 127.0.0.1 bind
   * only works for host-local sandboxes.
   */
  callbackBaseUrl?: string;
  /** Public dial-back listener for remote providers (absent = disabled). */
  publicIngress?: SandboxPublicIngressConfig;
  /** Daytona adapter (provider "daytona"). */
  daytona?: SandboxDaytonaConfig;
  /** E2B adapter (provider "e2b"). */
  e2b?: SandboxE2bConfig;
  /** Clone auth for remote-provider workspaces + runner bootstrap. */
  cloneCredential?: SandboxCloneCredential;
  /** Warm-on-typing prewarm pool (remote providers). Absent = defaults, with
   *  `enabled` true whenever a remote provider is configured. */
  prewarm?: Partial<SandboxPrewarmConfig>;
  /** Tarball URL of the backstage runner bundle for remote bootstrap (takes
   *  precedence over the git-clone fallback). */
  runnerBundleUrl?: string;
  /** Git URL of the backstage repo for remote bootstrap (default: this
   *  checkout's origin). */
  runnerRepoUrl?: string;
  /** Pinned sha/ref the remote bootstrap checks out (default: origin default). */
  runnerSha?: string;
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
    const path = configPath();
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
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
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
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
        snapshots:
          raw?.snapshots && typeof raw.snapshots === "object"
            ? {
                enabled: raw.snapshots.enabled === true,
                onIdle: raw.snapshots.onIdle !== false,
                maxPerSession:
                  typeof raw.snapshots.maxPerSession === "number" &&
                  raw.snapshots.maxPerSession >= 1
                    ? Math.floor(raw.snapshots.maxPerSession)
                    : SNAPSHOT_DEFAULTS.maxPerSession,
                quickSyncOnRestore: raw.snapshots.quickSyncOnRestore !== false,
              }
            : undefined,
        perRepo: Object.keys(perRepo).length ? perRepo : undefined,
        transport: raw?.transport === "ws" ? "ws" : undefined,
        callbackBaseUrl: str(raw?.callbackBaseUrl),
        publicIngress:
          raw?.publicIngress && typeof raw.publicIngress === "object"
            ? {
                enabled: raw.publicIngress.enabled === true,
                port:
                  typeof raw.publicIngress.port === "number" &&
                  Number.isInteger(raw.publicIngress.port) &&
                  raw.publicIngress.port > 0 &&
                  raw.publicIngress.port < 65536
                    ? raw.publicIngress.port
                    : PUBLIC_INGRESS_DEFAULT_PORT,
                host: str(raw.publicIngress.host) || "127.0.0.1",
                publicBaseUrl: str(raw.publicIngress.publicBaseUrl),
              }
            : undefined,
        daytona:
          raw?.daytona && typeof raw.daytona === "object"
            ? {
                apiKey: str(raw.daytona.apiKey),
                apiUrl: str(raw.daytona.apiUrl),
                target: str(raw.daytona.target),
                snapshot: str(raw.daytona.snapshot),
              }
            : undefined,
        e2b:
          raw?.e2b && typeof raw.e2b === "object"
            ? { apiKey: str(raw.e2b.apiKey), template: str(raw.e2b.template) }
            : undefined,
        cloneCredential:
          raw?.cloneCredential?.type === "https-token" ||
          raw?.cloneCredential?.type === "none"
            ? { type: raw.cloneCredential.type, token: str(raw.cloneCredential.token) }
            : undefined,
        prewarm:
          raw?.prewarm && typeof raw.prewarm === "object"
            ? {
                enabled:
                  typeof raw.prewarm.enabled === "boolean" ? raw.prewarm.enabled : undefined,
                ttlMinutes:
                  typeof raw.prewarm.ttlMinutes === "number" && raw.prewarm.ttlMinutes > 0
                    ? raw.prewarm.ttlMinutes
                    : undefined,
                maxLive:
                  typeof raw.prewarm.maxLive === "number" && raw.prewarm.maxLive >= 1
                    ? Math.floor(raw.prewarm.maxLive)
                    : undefined,
              }
            : undefined,
        runnerBundleUrl: str(raw?.runnerBundleUrl),
        runnerRepoUrl: str(raw?.runnerRepoUrl),
        runnerSha: str(raw?.runnerSha),
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

/** Effective snapshot settings — the config's `snapshots` block over the
 *  defaults; a missing block = the defaults with `enabled: false`. */
export function sandboxSnapshots(): SandboxSnapshotsConfig {
  return sandboxConfig().snapshots || SNAPSHOT_DEFAULTS;
}

/** Effective warm-on-typing prewarm settings (prewarm.ts pool). `enabled`
 *  defaults to true exactly when a remote provider (daytona/e2b) has an API
 *  key — a docker-only or unconfigured setup never prewarms paid compute. */
export function sandboxPrewarmConfig(): SandboxPrewarmConfig {
  const cfg = sandboxConfig();
  const remoteConfigured =
    sandboxConfigPresent() &&
    Boolean(
      cfg.daytona?.apiKey ||
        process.env.DAYTONA_API_KEY ||
        cfg.e2b?.apiKey ||
        process.env.E2B_API_KEY,
    );
  return {
    enabled: cfg.prewarm?.enabled ?? remoteConfigured,
    ttlMinutes: cfg.prewarm?.ttlMinutes ?? PREWARM_DEFAULTS.ttlMinutes,
    maxLive: cfg.prewarm?.maxLive ?? PREWARM_DEFAULTS.maxLive,
  };
}

/** Effective run transport (docker honors the config; remote providers pass
 *  their own "ws" regardless). */
export function sandboxTransport(): SandboxTransport {
  return sandboxConfig().transport === "ws" ? "ws" : "socket";
}

// ── Provider capability status (per-session provider picker) ────────────────

/** The providers a session can explicitly pick ("local" = no sandbox). */
export const RUNNABLE_SANDBOX_PROVIDERS = ["docker", "daytona", "e2b"] as const;
export type RunnableSandboxProviderId = (typeof RUNNABLE_SANDBOX_PROVIDERS)[number];

export function isRunnableSandboxProvider(v: unknown): v is RunnableSandboxProviderId {
  return (
    typeof v === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(v)
  );
}

/** Remote providers have no host mounts — their workspaces are ALWAYS
 *  volume-style (cloned inside the sandbox; no host fallback for runs). */
export function isRemoteSandboxProvider(v: unknown): v is "daytona" | "e2b" {
  return v === "daytona" || v === "e2b";
}

/** True when a sandbox config file exists and parses — the operator has set
 *  sandboxing up at all. Without it every provider is unconfigured. */
export function sandboxConfigPresent(): boolean {
  try {
    const path = configPath();
    if (!existsSync(path)) return false;
    JSON.parse(readFileSync(path, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

export interface SandboxProviderStatusEntry {
  id: RunnableSandboxProviderId;
  configured: boolean;
  /** Human caveat for a configured-but-unproven provider (e.g. daytona's WS
   *  dial-back can't be verified without creating a real sandbox). */
  note?: string;
}

/** Shape served by GET /backstage/api/sandbox/status (read fresh per call). */
export interface SandboxCapabilityStatus {
  /** A sandbox config file exists — the control surface is worth showing. */
  enabled: boolean;
  /** What `sandbox: true` resolves to (the config's default provider). */
  defaultProvider: SandboxProviderId;
  providers: SandboxProviderStatusEntry[];
  /** disable-sandboxes kill-switch file present — runs stay on the host. */
  killSwitch: boolean;
}

/**
 * Whether an explicit per-session provider is currently usable. Kept simple
 * (docs: "Sandbox provider dropdown"): docker is available whenever a sandbox
 * config exists; daytona/e2b additionally need their API key (config block or
 * env). This is the same gate `maybeLaunchSandboxedRun` re-checks per run.
 */
export function sandboxProviderConfigured(id: RunnableSandboxProviderId): boolean {
  if (!sandboxConfigPresent()) return false;
  const cfg = sandboxConfig();
  if (id === "docker") return true;
  if (id === "daytona") return Boolean(cfg.daytona?.apiKey || process.env.DAYTONA_API_KEY);
  return Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY);
}

/** Full provider-capability snapshot, read fresh from config + kill switch. */
export function sandboxCapabilityStatus(): SandboxCapabilityStatus {
  const enabled = sandboxConfigPresent();
  const cfg = sandboxConfig();
  const daytonaConfigured =
    enabled && Boolean(cfg.daytona?.apiKey || process.env.DAYTONA_API_KEY);
  const providers: SandboxProviderStatusEntry[] = [
    { id: "docker", configured: enabled },
    {
      id: "daytona",
      configured: daytonaConfigured,
      // Dial-back can only be proven by a real run, so a configured daytona
      // always carries the caveat (the UI renders it as a dim hint line).
      ...(daytonaConfigured
        ? {
            note: "dial-back unverified — the sandbox must reach callbackBaseUrl (org-tier egress applies); see docs/self-hosting-sandboxes.md",
          }
        : {}),
    },
    {
      id: "e2b",
      configured: enabled && Boolean(cfg.e2b?.apiKey || process.env.E2B_API_KEY),
    },
  ];
  return {
    enabled,
    defaultProvider: cfg.provider || "local",
    providers,
    killSwitch: !sandboxesEnabled(),
  };
}

/**
 * Resolve a create-path `sandbox` request (boolean | provider string) to the
 * provider to persist on the session, validating explicit picks against the
 * current config. `true` keeps today's behavior (config default provider);
 * a string must name a configured provider or the create fails with a clear
 * error. Returns `provider: null` for "no sandbox".
 */
export function resolveRequestedSandbox(
  requested: boolean | string | undefined | null,
  repoId?: string,
): { ok: true; provider: SandboxProviderId | null } | { ok: false; error: string } {
  if (!requested) return { ok: true, provider: null };
  if (requested === true)
    return { ok: true, provider: effectiveSandboxProvider(repoId) };
  const id = String(requested).trim().toLowerCase();
  if (id === "local") return { ok: true, provider: null }; // explicit "host"
  if (!isRunnableSandboxProvider(id)) {
    return {
      ok: false,
      error: `Unknown sandbox provider "${requested}" — valid values: docker, daytona, e2b (or true for the configured default).`,
    };
  }
  if (!sandboxProviderConfigured(id)) {
    const hint =
      id === "docker"
        ? "create ~/.opensession-sandbox.json (see docs/self-hosting-sandboxes.md)"
        : id === "daytona"
          ? 'set {"daytona":{"apiKey":"…"}} in ~/.opensession-sandbox.json (or DAYTONA_API_KEY)'
          : 'set {"e2b":{"apiKey":"…"}} in ~/.opensession-sandbox.json (or E2B_API_KEY)';
    return {
      ok: false,
      error: `Sandbox provider "${id}" is not configured — ${hint}.`,
    };
  }
  return { ok: true, provider: id };
}

/**
 * The base URL sandboxes dial back to (run-ws / rpc-ws routes). Config value
 * wins; the fallback derives from the server's bind env (HOST:PORT — the same
 * defaults backstage.ts uses). http(s) schemes are normalized to ws(s).
 * NOTE: a 127.0.0.1 default is unreachable from any sandbox — ws-transport
 * setups should set callbackBaseUrl explicitly (Tailscale URL for remote
 * providers; the docker bridge can reach the host's tailnet/LAN bind).
 */
export function sandboxCallbackBaseUrl(): string {
  const cfg = sandboxConfig();
  let base =
    cfg.callbackBaseUrl ||
    `ws://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3850"}`;
  return normalizeWsBase(base);
}

function normalizeWsBase(base: string): string {
  return base.replace(/^http(s?):\/\//, "ws$1://").replace(/\/+$/, "");
}

/** The publicIngress block when it's actually enabled, else null. */
export function publicIngressConfig(): SandboxPublicIngressConfig | null {
  const pi = sandboxConfig().publicIngress;
  return pi?.enabled ? pi : null;
}

/**
 * The base URL REMOTE-provider sandboxes (daytona/e2b) dial back to: the
 * public-ingress URL when the isolated public listener is enabled and has a
 * publicBaseUrl, else the plain callbackBaseUrl (tailnet/self-hosted setups
 * where the sandbox can reach the main bind directly). Docker sandboxes never
 * use this — they stay on sandboxCallbackBaseUrl (the internal bridge path).
 */
export function remoteSandboxCallbackBaseUrl(): string {
  const pi = publicIngressConfig();
  if (pi?.publicBaseUrl) return normalizeWsBase(pi.publicBaseUrl);
  return sandboxCallbackBaseUrl();
}
