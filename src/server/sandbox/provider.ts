/**
 * Sandbox seam (Phase 0 of the sandbox rollout plan): the interfaces every
 * execution backend implements. A "sandbox" is where a session's work happens —
 * today that's a git worktree on this host (LocalProvider, src/server/sandbox/
 * local.ts); later it can be a Docker container per session, or a remote
 * Daytona/E2B sandbox, all behind these two interfaces.
 *
 * Deliberately small, mirroring the existing run-host layer's idioms:
 *  - `launchRun` takes the same serializable `RunHostSpec` the detached
 *    run-host processes consume (src/runner-host/protocol.ts) and yields the
 *    same `StreamEvent` generator shape as runAgent / runAgentHosted.
 *  - `RunHandle`'s control surface mirrors host-registry's `HostRunControl`
 *    (steer / interruptSteer / cancel returning booleans, `steerable` flag).
 *
 * Phase 0 is zero behavior change: nothing in backstage.ts threads a Sandbox
 * handle yet — `runSessionPromptInner` still computes a bare `cwd` itself.
 * Threading the handle through the prompt/create paths is the documented
 * Phase 1 TODO (see the sandbox rollout plan §5 Phase 1).
 */

import type { StreamEvent } from "../run-events";
import type { RunAgentOpts } from "../agent-runner";
import type { RunHostSpec } from "../../runner-host/protocol";

/** The provider ids the registry knows. Only "local" is wired in Phase 0. */
export type SandboxProviderId =
  | "local"
  | "docker"
  | "daytona"
  | "e2b"
  | "box"
  | "modal"
  | "microvm"
  | "lambda-microvm";

/**
 * Everything a provider needs to create-or-reuse the sandbox for a session.
 * For the local provider this resolves to a worktree path via the existing
 * worktree.ts helpers; container providers additionally key their
 * container/volume names off `sessionId`.
 */
export interface SandboxSessionSpec {
  /** Backstage session id (bks-…). Container providers name resources by it. */
  sessionId: string;
  /** Registered repo id (worktree.ts REPOS). Defaults to tella-fusion. */
  repo?: string;
  /** Branch for code-mode worktrees. Required unless ask/sharedCheckout/cwd. */
  branch?: string;
  mode?: "ask" | "code" | "scratch";
  /**
   * Already-resolved workspace dir (an existing session's `worktreeDir`).
   * When set, providers reuse it (reviving a cleaned-up worktree from
   * `branch` when the dir is gone) instead of resolving a fresh one.
   */
  cwd?: string;
  /** Stack base: branch the new worktree branches off (createWorktree opts.base). */
  base?: string;
  /**
   * Attached-repo worktree dirs (multi-repo sessions). Bind-mode docker
   * sandboxes mount each at its identical path (plus its repo's common .git)
   * so the agent can cd into them; a change to this set recreates the
   * container on the next ensure. Volume-mode workspaces reject attachments.
   */
  attachedDirs?: string[];
  /**
   * What must run inside the sandbox. "runner" (the default) provisions the
   * full agent harness; "workspace" keeps the model loop/auth on the host and
   * provisions only the filesystem command runtime used by
   * opensession-workspace.
   */
  runtime?: "runner" | "workspace";
}

export interface ExecOpts {
  /** Extra env for the command (merged over the provider's baseline). */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One published sandbox port. Docker publishes to a loopback host port
 *  (Caddy fronts it); remote providers only hand out a preview URL on their
 *  own domain — either field may be present. */
export interface PortEntry {
  /** Host loopback port the sandbox port is published on (docker). */
  hostPort?: number;
  /** Direct preview URL (remote providers' port-forward domains). */
  url?: string;
}

/** Preview port mapping: port inside the sandbox → where to reach it. A bare
 *  number is shorthand for `{hostPort}` (the docker provider's shape).
 *  Local sandboxes run on the host network, so theirs is always empty. */
export type PortMap = Record<number, number | PortEntry>;

export type SandboxStatus = "running" | "stopped" | "gone";

/**
 * Callbacks a caller attaches to a launched run — the non-serializable
 * counterpart of RunHostSpec, matching host-client's HandleCallbacks /
 * HostedRunOpts split (asks are proxied back to whoever can answer them).
 */
export interface RunHandleCallbacks {
  onAskUser?: RunAgentOpts["onAskUser"];
  /**
   * Builds the in-process SDK MCP servers (opensession-sessions/-admin/…) for
   * runs executing inside this process. Hosted/containerized runs ignore it —
   * they reach the same tools via the stdio→RPC proxy path
   * (RunHostSpec.proxyMcpServers + rpcToken).
   */
  inProcessMcp?: () => Record<string, unknown> | undefined;
  /**
   * A steer reached the run too late (already finishing) or the backend can't
   * steer — the caller should queue the text for delivery after the run
   * instead of dropping it. Mirrors host-client's HandleCallbacks. Only fires
   * for out-of-process runs; in-process steers report failure synchronously.
   */
  onSteerFailed?: (text: string) => void;
}

/**
 * A long-lived agent run inside a sandbox. `events()` is the same
 * AsyncGenerator<StreamEvent> shape every runner entry point yields — consume
 * it exactly once. The control methods mirror HostRunControl and return false
 * when the run can't honor the request (caller queues instead).
 */
export interface RunHandle {
  events(): AsyncGenerator<StreamEvent>;
  /** Whether the run's backend supports mid-run steering (claude yes, exec-codex no). */
  steerable: boolean;
  steer(text: string): boolean;
  interruptSteer(text: string): boolean;
  cancel(): boolean;
}

/**
 * One session's execution environment. `id` is journaled on ActiveRunRecord
 * (`sandboxId`) and the session file so a restarted backstage can reattach via
 * `SandboxProvider.get()`.
 */
export interface Sandbox {
  id: string;
  provider: SandboxProviderId;
  /** Workspace path *inside* the sandbox (== host path for local + bind-mount Docker). */
  cwd: string;
  /** How the workspace is materialized (docker only): "bind" = host worktree
   *  bind-mounted at the identical path; "volume" = cloned into a per-session
   *  volume, no host copy. Undefined for local (the host dir IS the workspace). */
  workspace?: "bind" | "volume";
  /** How the current container came to exist (docker only): "fresh" = created
   *  from the base image, "snapshot-restore" = recreated from a per-session
   *  snapshot image. Lifecycle scripts get it as BACKSTAGE_BOOT_MODE (the
   *  background-agents boot-mode pattern). */
  bootMode?: "fresh" | "snapshot-restore";
  /** One-shot commands in the workspace (git status, ls-files, …). Never throws
   *  on non-zero exit — inspect `exitCode`. */
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Start a long-lived agent run (NDJSON-stream semantics; see RunHandle). */
  launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle;
  /**
   * Like `launchRun`, but the sandbox-side setup (container exec, socket
   * connect) is awaited HERE and a failure THROWS instead of surfacing as an
   * error event on the stream — so a caller with a fallback path (e.g. run on
   * the host instead) can catch it before committing to the sandbox. Optional:
   * only backends whose launch can fail out-of-process implement it; the local
   * provider's in-process launch has nothing to await.
   */
  launchRunEager?(spec: RunHostSpec, cb?: RunHandleCallbacks): Promise<RunHandle>;
  /** Preview ports (sandbox port → host port). */
  ports(): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
}

export interface SandboxProvider {
  id: SandboxProviderId;
  /** Create-or-reuse the sandbox for a session. Idempotent. */
  ensure(spec: SandboxSessionSpec): Promise<Sandbox>;
  /** Reattach to a known sandbox after a restart; null when it's gone. */
  get(sandboxId: string): Promise<Sandbox | null>;
  /** Tear the sandbox down (session delete/archive). Workspace data outlives
   *  it where the provider stores it on the host (local worktrees always do). */
  destroy(sandboxId: string): Promise<void>;
}
