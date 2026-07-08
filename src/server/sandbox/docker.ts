/**
 * DockerProvider — the Docker sandbox backend (docs/sandboxes-plan.md §5
 * Phase 1, "bind-mount mode").
 *
 * One long-lived container per session (`bks-sbx-<sessionId>`, image
 * `backstage-runner:latest` — see deploy/sandbox/), kept alive across turns so
 * engine session state (~/.claude history, codex rollouts) and dev servers
 * survive. A run is the SAME runner-host entry the systemd path uses
 * (src/runner-host/host.ts), `docker exec`'d into the container; backstage
 * talks to it over the host's unix socket in a bind-mounted per-session run
 * dir, reusing host-client's HostHandle (NDJSON protocol, ask proxying,
 * reconnect, respawn-to-resume) with a Docker HostLauncher. Because the
 * socket + spec/meta/journal files live on a bind mount, a restarted
 * backstage reattaches to a still-running in-container run exactly like it
 * would to a systemd host — that's what makes restart-resume work.
 *
 * Mount design (all deliberate, see also deploy/sandbox/README.md):
 *
 *  - NO volume at /home/ubuntu. The image bakes the claude CLI and the runner
 *    bundle under /home/ubuntu; a $HOME volume would shadow both (and copy the
 *    ~223MB vendored codex binary per session). Engine state persists in two
 *    named volumes mounted at exactly ~/.claude and ~/.codex.
 *  - The session worktree is bind-mounted rw at its IDENTICAL host path, so
 *    @-mention search, diff, git status/push and previews keep working
 *    host-side with zero changes.
 *  - Git worktrees are not self-contained: `<worktree>/.git` is a file whose
 *    gitdir points at `<main-checkout>/.git/worktrees/<name>` by absolute
 *    path, and objects/refs live in the main checkout's .git. So the main
 *    checkout's `.git` directory is ALSO bind-mounted rw at its identical
 *    path (resolved via `git rev-parse --git-common-dir`, never guessed).
 *    Mounting the shared .git rw is an accepted Phase 1 tradeoff: a sandboxed
 *    session can touch other worktrees' refs — same trust level as host runs
 *    today. Phase 2's volume-owned workspaces remove it.
 *  - ~/.claude/projects/<munged-cwd> (the engine transcript dir for THIS cwd)
 *    is bind-mounted from the host over the ~/.claude volume, so the session
 *    viewer's transcript tail, parseTranscript handoffs, and resume-continuity
 *    with host runs of the same worktree all keep working. Narrow on purpose:
 *    only this worktree's transcript dir, not the host's whole ~/.claude.
 *  - The run-rpc socket (~/.backstage-chats/backstage-rpc.sock) is
 *    bind-mounted (a socket can't be mounted ro) so the michael-* stdio
 *    proxies work from inside. Caveat: if backstage rebinds the socket (real
 *    restart), the bind still points at the old inode until the CONTAINER is
 *    restarted — the idle-stop/start cycle self-heals this, and mcp-proxy
 *    retries until then.
 *  - ~/.ssh, ~/.gitconfig, ~/.config/gh, mcp-config.json and
 *    ~/.backstage-claude-accounts.json are mounted read-only for git/gh/PR
 *    parity and in-container account-pool selection. Interactive sessions
 *    only — the same ambient trust those runs already have on the host today.
 *    Automations are NOT sandboxed in Phase 1 (the wiring refuses them), so
 *    none of this is reachable from untrusted prompt text.
 *  - ~/.backstage-audit is mounted rw so in-container runs land in the same
 *    audit log stream as host runs (appendFileSync, O_APPEND).
 *
 * Phase 2 additions (docs/sandboxes-plan.md §5 Phase 2):
 *  - VOLUME workspaces (config `workspace: "volume"`, new sandboxes only): the
 *    workspace is a per-session named volume (`<name>-ws`) mounted at the
 *    session's canonical worktree path, cloned from the repo's origin INSIDE
 *    the container (host creds mounted ro do the auth) — no host worktree at
 *    all. The mode is sticky per sandbox (recorded in the state file; a later
 *    config flip never re-mounts an existing workspace). destroy() removes the
 *    workspace volume — that data loss is the mode's contract: push your work.
 *    Host-side reads (diff/status/@-mentions) reach it through the
 *    workspace-exec choke point. A local-path origin URL (scratch/test repos)
 *    is mounted ro so the in-container clone can read it; real repos clone
 *    over ssh/https. Attached repos are rejected in volume mode.
 *  - Attached-repo mounts (bind mode): each attachedDirs entry is bind-mounted
 *    rw at its identical path plus its repo's common .git — a changed set
 *    recreates the container on the next ensure (mounts are create-time).
 *  - Preview ports: config `previewPorts` publishes each listed container port
 *    to a random loopback host port at create time (docker -p 127.0.0.1::p);
 *    `ports()` reads the live mapping for preview.ts's Caddy routing.
 *
 * Known Phase 1 caveats (documented, not chased):
 *  - External MCP servers from mcp-config.json now spawn INSIDE the container;
 *    ones with host-only deps won't start there.
 *  - Codex models: codex account homes (CODEX_HOME dirs) are not mounted, so
 *    codex runs inside a sandbox have no account pool yet. Claude first.
 *  - `aws: true` runs can't mint creds inside the container (IMDS is blocked
 *    by the DOCKER-USER rule — deploy/sandbox/setup-host.sh); getAgentAwsEnv
 *    degrades to no AWS env.
 *
 * Runner internals: nothing here hot-reloads meaningfully into live runs —
 * wire-ups need a real restart (see CLAUDE.md "Hot reload & restarts").
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { BACKSTAGE_CHATS_DIR } from "../paths";
import {
  journalSet,
  journalClear,
  type ActiveRunRecord,
  type StreamEvent,
} from "../claude-runner";
import { RESUME_CONTINUATION_PROMPT } from "../agent-runner";
import { providerFor } from "../models";
import { hostRunBusy, hostSteer, hostInterruptSteer, hostCancel } from "../host-registry";
import { registerRunToken } from "../run-rpc";
import { writeJsonAtomic } from "../shared/atomic-write";
import { HostHandle, type HandleCallbacks, type HostLauncher } from "../host-client";
import { getTranscriptPath } from "../sessions";
import { REPOS, getRepo, worktreePathFor, type Repo } from "../worktree";
import { LocalProvider } from "./local";
import { sandboxConfig } from "./config";
import {
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_LOG_NAME,
  HOST_ENTRY,
  rpcSocketPath,
  type RunHostSpec,
  type RunHostMeta,
} from "../../runner-host/protocol";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "./provider";

const HOME = process.env.HOME || "/home/ubuntu";
const CONTAINER_PREFIX = "bks-sbx-";
const DEFAULT_IMAGE = "backstage-runner:latest";
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY = "8g";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Provider-owned state, one file per sandbox — lets get() reattach (or fully
 *  recreate a removed container with identical mounts) after any restart. */
const STATE_DIR = `${BACKSTAGE_CHATS_DIR}/sandboxes`;
/** Per-session run dirs (spec/meta/journal/socket/log per run), bind-mounted
 *  into the session's container at the identical path. */
const RUNS_BASE = `${BACKSTAGE_CHATS_DIR}/sandbox-runs`;

interface DockerSandboxState {
  sandboxId: string;
  sessionId: string;
  cwd: string;
  image: string;
  createdAt: string;
  /** Last run start/end — drives the idle-stop sweep. */
  lastActivityAt: string;
  /** How the workspace is materialized. Sticky for the sandbox's lifetime;
   *  absent (pre-Phase-2 state files) = "bind". */
  workspace?: "bind" | "volume";
  /** Repo id + branch, recorded so get() can recreate a volume workspace's
   *  container (the clone source and checkout) after a docker rm. */
  repoId?: string;
  branch?: string;
  /** Attached-repo dirs mounted at create time (bind mode) — a differing set
   *  on the next ensure() recreates the container with fresh mounts. */
  attachedDirs?: string[];
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
}

export function containerNameFor(sessionId: string): string {
  return `${CONTAINER_PREFIX}${sanitizeName(sessionId)}`.slice(0, 100);
}

function statePath(sandboxId: string): string {
  return `${STATE_DIR}/${sandboxId}.json`;
}

function readState(sandboxId: string): DockerSandboxState | null {
  try {
    if (!existsSync(statePath(sandboxId))) return null;
    return JSON.parse(readFileSync(statePath(sandboxId), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: DockerSandboxState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(statePath(state.sandboxId), state);
}

function touchStateActivity(sandboxId: string): void {
  const s = readState(sandboxId);
  if (s) {
    s.lastActivityAt = new Date().toISOString();
    writeState(s);
  }
}

function sessionRunsDir(sessionId: string): string {
  return `${RUNS_BASE}/${sanitizeName(sessionId)}`;
}

/** Run `docker <args>` (argv array — nothing is shell-interpolated). */
async function docker(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? 120_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function containerStatus(name: string): Promise<SandboxStatus> {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  if (r.exitCode !== 0) return "gone";
  return r.stdout.trim() === "running" ? "running" : "stopped";
}

/** Container status by name, for callers outside this module (the
 *  workspace-exec choke point checks "actually running" without starting). */
export function dockerContainerStatus(name: string): Promise<SandboxStatus> {
  return containerStatus(name);
}

/**
 * A raw in-container exec bound to `cwd` that NEVER starts a stopped
 * container (unlike Sandbox.exec) — the workspace-exec choke point uses it
 * for read surfaces, where waking a stopped sandbox just to run `git status`
 * would defeat the idle-stop policy. A container that stops between the
 * caller's status check and the exec simply returns a non-zero exit.
 */
export function rawDockerExec(container: string, cwd: string) {
  return (cmd: string[], opts?: ExecOpts): Promise<ExecResult> => {
    const envArgs = Object.entries(opts?.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return docker(["exec", "-w", cwd, ...envArgs, container, ...cmd]);
  };
}

async function ensureStarted(name: string): Promise<void> {
  const st = await containerStatus(name);
  if (st === "running") return;
  if (st === "gone") throw new Error(`sandbox container ${name} does not exist`);
  const r = await docker(["start", name]);
  if (r.exitCode !== 0) {
    throw new Error(`docker start ${name} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
}

/** Paths that end up inside a `sh -c` log-redirect line must be boring. They
 *  are always provider-constructed (BACKSTAGE_CHATS_DIR + sanitized ids), so
 *  this is an assertion, not an escape. */
function assertSafePath(p: string): string {
  if (!/^[A-Za-z0-9_\/.@:-]+$/.test(p)) {
    throw new Error(`refusing unsafe path for in-container exec: ${p}`);
  }
  return p;
}

/** Host-side resolution of the main checkout's .git dir for a worktree —
 *  `<worktree>/.git` is a pointer file; the common dir holds objects/refs. */
async function gitCommonDir(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git rev-parse --git-common-dir failed in ${cwd}: ${err.trim()}`);
  return resolvePath(cwd, out.trim());
}

// ── Container creation ────────────────────────────────────────────────────────

function isMainCheckout(cwd: string): boolean {
  return Object.values(REPOS).some((r) => r.repo === cwd);
}

/** Host-side resolution of a repo's origin URL — the clone source for
 *  volume-mode workspaces. */
async function repoOriginUrl(repoDir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || !out.trim()) {
    throw new Error(`cannot resolve origin URL for ${repoDir}: ${err.trim() || "no origin"}`);
  }
  return out.trim();
}

interface CreateContainerOpts {
  workspace: "bind" | "volume";
  /** Attached-repo worktrees to mount (bind mode only). */
  attachedDirs: string[];
  /** Repo backing a volume workspace (clone source + default branch). */
  repo?: Repo;
}

async function createContainer(
  name: string,
  sessionId: string,
  cwd: string,
  opts: CreateContainerOpts,
): Promise<void> {
  const cfg = sandboxConfig();
  const image = cfg.image || DEFAULT_IMAGE;
  const cpus = cfg.cpus || DEFAULT_CPUS;
  const memory = cfg.memory || DEFAULT_MEMORY;

  const vol = (host: string, container: string, ro = false) => [
    "-v",
    `${host}:${container}${ro ? ":ro" : ""}`,
  ];

  // Workspace mounts. Bind mode: the host worktree + its git common dir, rw at
  // identical paths. Volume mode: a per-session named volume at the canonical
  // worktree path (cloned by setupVolumeWorkspace after start) — plus the
  // origin repo itself mounted ro when it's a local path (scratch/test repos),
  // since the in-container clone must be able to read its source.
  const workspaceMounts: string[] = [];
  if (opts.workspace === "volume") {
    workspaceMounts.push(...vol(`${name}-ws`, cwd));
    const originUrl = opts.repo ? await repoOriginUrl(opts.repo.repo) : "";
    if (originUrl.startsWith("/") && existsSync(originUrl)) {
      workspaceMounts.push(...vol(originUrl, originUrl, true));
    }
  } else {
    const commonGit = await gitCommonDir(cwd);
    if (commonGit === `${cwd}/.git`) {
      // Standalone checkout (not a linked worktree) — only ever legitimate for
      // scratch/test repos; main checkouts were already refused in ensure().
      console.warn(`[sandbox] ${name}: ${cwd} is a standalone checkout (no separate common .git)`);
    }
    workspaceMounts.push(
      ...vol(cwd, cwd),
      ...(commonGit !== `${cwd}/.git` ? vol(commonGit, commonGit) : []),
    );
    // Attached repos (multi-repo sessions): each worktree + its repo's common
    // .git, rw at identical paths — same trust as the primary workspace.
    const mounted = new Set([cwd, commonGit]);
    for (const dir of opts.attachedDirs) {
      if (mounted.has(dir)) continue;
      mounted.add(dir);
      workspaceMounts.push(...vol(dir, dir));
      try {
        const attCommon = await gitCommonDir(dir);
        if (attCommon !== `${dir}/.git` && !mounted.has(attCommon)) {
          mounted.add(attCommon);
          workspaceMounts.push(...vol(attCommon, attCommon));
        }
      } catch (e) {
        console.warn(`[sandbox] ${name}: could not resolve common .git for attached ${dir}:`, e);
      }
    }
  }

  const runsDir = sessionRunsDir(sessionId);
  mkdirSync(runsDir, { recursive: true });
  // Engine transcript dir for this cwd, host-side (see mount design above).
  // Volume mode keeps it too: transcripts are engine state, not workspace —
  // mounting them host-side keeps the session viewer's tail working.
  const transcriptDir = dirname(getTranscriptPath(cwd, "x"));
  mkdirSync(transcriptDir, { recursive: true });

  const mounts: string[] = [
    // Named volumes ONLY at ~/.claude and ~/.codex — never at /home/ubuntu
    // (a $HOME volume would shadow the image's claude install + repo bundle).
    ...vol(`${name}-claude`, `${HOME}/.claude`),
    ...vol(`${name}-codex`, `${HOME}/.codex`),
    ...workspaceMounts,
    // Host-visible engine transcripts for this cwd (over the .claude volume).
    ...vol(transcriptDir, transcriptDir),
    // Per-session run dirs: spec/meta/journal/host.sock/log for every run.
    ...vol(runsDir, runsDir),
    // Audit log parity (append-only jsonl stream). Deliberately rw where the
    // other trust mounts are ro: in-container runs must land in the SAME audit
    // stream as host runs (append-only writes via O_APPEND), and host runs can
    // already write here today — so this is parity with host-run trust, not an
    // escalation. Worst case a hostile run scribbles on its own audit trail;
    // it gains no credentials or control surface from it.
    ...vol(`${HOME}/.backstage-audit`, `${HOME}/.backstage-audit`),
  ];
  mkdirSync(`${HOME}/.backstage-audit`, { recursive: true });

  // run-rpc socket (michael-* proxies). Guard: mounting a MISSING host path
  // would make docker create a directory there and break run-rpc's bind.
  const rpcSock = rpcSocketPath(BACKSTAGE_CHATS_DIR);
  try {
    if (statSync(rpcSock).isSocket()) mounts.push(...vol(rpcSock, rpcSock));
    else console.warn(`[sandbox] ${rpcSock} exists but is not a socket — michael-* proxies disabled`);
  } catch {
    console.warn(`[sandbox] ${rpcSock} missing — michael-* proxies will be unavailable in ${name}`);
  }

  // Read-only trust mounts (interactive parity — see header).
  const roIfExists = (p: string, label: string) => {
    if (existsSync(p)) mounts.push(...vol(p, p, true));
    else console.warn(`[sandbox] ${label} (${p}) missing — skipping mount for ${name}`);
  };
  roIfExists(`${HOME}/.ssh`, "ssh keys");
  roIfExists(`${HOME}/.gitconfig`, "gitconfig");
  roIfExists(`${HOME}/.config/gh`, "gh config");
  roIfExists(
    process.env.BACKSTAGE_MCP_CONFIG || `${HOME}/projects/tella-backstage/mcp-config.json`,
    "mcp-config.json",
  );
  roIfExists(
    process.env.BACKSTAGE_CLAUDE_ACCOUNTS_PATH || `${HOME}/.backstage-claude-accounts.json`,
    "claude account pool",
  );

  // Preview ports: publish each configured container port on a random
  // LOOPBACK host port (Caddy fronts them with the tailnet HTTPS origin —
  // see preview.ts; nothing is exposed off-host). Create-time only: adding
  // ports to the config affects new/recreated containers.
  const portArgs = (cfg.previewPorts || []).flatMap((p) => ["-p", `127.0.0.1::${p}`]);

  const r = await docker([
    "create",
    "--name", name,
    "--label", "backstage.sandbox=1",
    "--label", `backstage.session=${sessionId}`,
    "--init",
    "--restart", "no",
    "--cpus", String(cpus),
    "--memory", memory,
    ...portArgs,
    ...mounts,
    image,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`docker create ${name} failed: ${r.stderr.trim().slice(0, 500)}`);
  }
}

/**
 * Materialize a volume workspace after (re)start: clone from origin (host
 * creds are mounted ro; local-path origins are mounted ro by createContainer)
 * and check out the session's branch — tracking origin/<branch> when it
 * exists, else cut from origin/<defaultBranch>, mirroring createWorktree.
 * Idempotent: an already-cloned volume only re-verifies the checkout.
 */
async function setupVolumeWorkspace(
  name: string,
  cwd: string,
  repo: Repo,
  branch: string,
): Promise<void> {
  // A fresh named volume's mountpoint is root-owned (the path doesn't exist
  // in the image, so there's no ownership to copy) — chown before cloning.
  const own = await docker(["exec", "-u", "0", name, "chown", "1000:1000", assertSafePath(cwd)]);
  if (own.exitCode !== 0) {
    throw new Error(`sandbox ${name}: chown of workspace volume failed: ${own.stderr.trim().slice(0, 300)}`);
  }
  const cloned = await docker(["exec", name, "test", "-d", `${cwd}/.git`]);
  if (cloned.exitCode !== 0) {
    const originUrl = await repoOriginUrl(repo.repo);
    console.log(`[sandbox] ${name}: cloning ${originUrl} into workspace volume at ${cwd}`);
    const clone = await docker(
      ["exec", name, "git", "clone", "--", originUrl, cwd],
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`sandbox ${name}: in-container clone failed: ${clone.stderr.trim().slice(0, 500)}`);
    }
  }
  const cur = await docker(["exec", "-w", assertSafePath(cwd), name, "git", "branch", "--show-current"]);
  if (cur.exitCode === 0 && cur.stdout.trim() === branch) return;
  const hasRemote = await docker([
    "exec", "-w", cwd, name,
    "git", "rev-parse", "--verify", "--quiet", `origin/${branch}`,
  ]);
  const startPoint = hasRemote.exitCode === 0 ? `origin/${branch}` : `origin/${repo.defaultBranch}`;
  const co = await docker(["exec", "-w", cwd, name, "git", "checkout", "-B", branch, startPoint]);
  if (co.exitCode !== 0) {
    throw new Error(`sandbox ${name}: checkout -B ${branch} ${startPoint} failed: ${co.stderr.trim().slice(0, 300)}`);
  }
}

/** One-time in-container setup after (re)start. Idempotent. */
async function setupContainer(name: string, cwd: string): Promise<void> {
  // Seed ~/.claude/settings.json when the volume is empty — the volume mount
  // shadows the image's seeded file (docker's copy-up covers the very first
  // mount, but not a volume that was created empty out-of-band).
  const seed = await docker([
    "exec", name, "sh", "-c",
    `test -s ${HOME}/.claude/settings.json || printf '{}' > ${HOME}/.claude/settings.json`,
  ]);
  if (seed.exitCode !== 0) {
    throw new Error(`sandbox ${name}: seeding ~/.claude failed: ${seed.stderr.trim().slice(0, 300)}`);
  }
  // Trap (b) from the plan: verify the worktree actually works inside — the
  // .git pointer file must resolve through the mounted common dir.
  const git = await docker(["exec", "-w", assertSafePath(cwd), name, "git", "status", "--porcelain"]);
  if (git.exitCode !== 0) {
    throw new Error(
      `sandbox ${name}: git status failed inside the container (worktree/.git mounts broken?): ${git.stderr.trim().slice(0, 300)}`,
    );
  }
}

// ── The docker HostLauncher: `docker exec` instead of systemd-run ─────────────

function makeDockerLauncher(container: string, sessionId: string): HostLauncher {
  return {
    async alive(dir, meta: RunHostMeta | null) {
      if (!meta?.pid) return false;
      const r = await docker(["exec", container, "kill", "-0", String(meta.pid)]);
      return r.exitCode === 0;
    },
    newRunDir: (hostId) => `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    async launch(_hostId, dir) {
      await ensureStarted(container);
      const specPath = assertSafePath(`${dir}/${HOST_SPEC_NAME}`);
      const logPath = assertSafePath(`${dir}/${HOST_LOG_NAME}`);
      // Detached exec (-d): the in-container host must NOT die with backstage —
      // its socket lives on the bind-mounted run dir, so a restarted backstage
      // reconnects. All output goes to the run dir's host.log (host-visible).
      // Env mirrors what launchHostUnit provides, MINUS ~/.backstage.env:
      // the container gets no ambient credentials; MCP servers carry their own
      // env via mcp-config.json, and the account pool file is mounted ro.
      const env = (kv: string) => ["-e", kv];
      const args = [
        "exec", "-d",
        ...env(`BACKSTAGE_RUN_JOURNAL=${dir}/journal.json`),
        ...env("NODE_ENV=production"),
        ...(process.env.MICHAEL_MODEL ? env(`MICHAEL_MODEL=${process.env.MICHAEL_MODEL}`) : []),
        ...(process.env.MICHAEL_UI_BASE ? env(`MICHAEL_UI_BASE=${process.env.MICHAEL_UI_BASE}`) : []),
        container,
        "sh", "-c",
        `exec bun run ${assertSafePath(HOST_ENTRY)} ${specPath} >> ${logPath} 2>&1`,
      ];
      const r = await docker(args);
      if (r.exitCode !== 0) {
        throw new Error(`docker exec (run host) failed: ${r.stderr.trim().slice(0, 400)}`);
      }
    },
  };
}

// ── Run journal bookkeeping (backstage side) ──────────────────────────────────

function recordForSpec(spec: RunHostSpec, sandboxId: string): ActiveRunRecord {
  return {
    runKey: spec.hostId,
    bksSessionId: spec.bksSessionId,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    deniedTools: spec.deniedTools,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    model: spec.model,
    effort: spec.effort,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    fallbackModel: spec.fallbackModel,
    sandboxId,
    sandboxProvider: "docker",
    kind: spec.journalKind || "prompt",
    startedAt: new Date().toISOString(),
  };
}

/**
 * Journal the run in the shared active-runs.json (with sandboxId/provider so
 * resumeInterruptedRuns can reattach through this module after a restart),
 * track the engine session id from init events, and clear on completion.
 */
async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
): AsyncGenerator<StreamEvent> {
  journalSet(record);
  touchStateActivity(record.sandboxId!);
  try {
    for await (const ev of events) {
      if (ev.type === "init" && ev.sessionId && ev.sessionId !== record.claudeSessionId) {
        record.claudeSessionId = ev.sessionId;
        journalSet(record);
      }
      yield ev;
    }
  } finally {
    journalClear(record.runKey);
    touchStateActivity(record.sandboxId!);
  }
}

// ── Sandbox handle ────────────────────────────────────────────────────────────

function makeDockerSandbox(
  sandboxId: string,
  sessionId: string,
  cwd: string,
  workspace: "bind" | "volume" = "bind",
): Sandbox {
  const launcher = makeDockerLauncher(sandboxId, sessionId);
  const sandboxHandle: Sandbox = {
    id: sandboxId,
    provider: "docker",
    cwd,
    workspace,

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      await ensureStarted(sandboxId);
      const envArgs = Object.entries(opts?.env || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      return docker(["exec", "-w", cwd, ...envArgs, sandboxId, ...cmd]);
    },

    /**
     * Eager variant: awaits the docker exec + socket connect and THROWS on any
     * launch failure, so callers with a fallback (maybeLaunchSandboxedRun →
     * host run) can catch it before committing the turn to the sandbox.
     */
    async launchRunEager(spec: RunHostSpec, cb?: RunHandleCallbacks): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      const record = recordForSpec(spec, sandboxId);
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
      let handle: HostHandle;
      try {
        await launcher.launch(spec.hostId, dir);
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await handle.connectWithWait(30_000);
      } catch (e) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        throw e;
      }
      const gen = withRunJournal(handle.events(), record);
      return {
        events: () => gen,
        steerable: providerFor(spec.model) !== "codex",
        // HostHandle registers its control in host-registry keyed by the bks
        // session id — route through the same helpers the WS handlers use.
        steer: (text) => hostSteer(spec.bksSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.bksSessionId, text),
        cancel: () => hostCancel(spec.bksSessionId),
      };
    },

    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
      // Setup is async but RunHandle is sync — do the launch inside the
      // generator (consumed exactly once, like every runner entry point) and
      // degrade a launch failure to an error event. Callers that can fall back
      // to another backend should prefer launchRunEager above.
      const gen = (async function* (): AsyncGenerator<StreamEvent> {
        let eager: RunHandle;
        try {
          eager = await sandboxHandle.launchRunEager!(spec, cb);
        } catch (e: any) {
          yield {
            type: "error",
            content: `Sandbox run failed to start: ${e?.message || e}`,
          };
          return;
        }
        yield* eager.events();
      })();
      return {
        events: () => gen,
        steerable: providerFor(spec.model) !== "codex",
        steer: (text) => hostSteer(spec.bksSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.bksSessionId, text),
        cancel: () => hostCancel(spec.bksSessionId),
      };
    },

    // Live published-port mapping (container port → loopback host port).
    // Empty when the container isn't running or no previewPorts are
    // configured. preview.ts routes Caddy at the host side of this map.
    async ports(): Promise<PortMap> {
      const r = await docker(["port", sandboxId]);
      if (r.exitCode !== 0) return {};
      const map: PortMap = {};
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^(\d+)\/tcp -> (?:\[[^\]]*\]|[0-9.]+):(\d+)\s*$/);
        if (!m) continue;
        const inner = parseInt(m[1], 10);
        if (!(inner in map)) map[inner] = parseInt(m[2], 10);
      }
      return map;
    },

    status: () => containerStatus(sandboxId),
  };
  return sandboxHandle;
}

// ── Idle-stop sweep ───────────────────────────────────────────────────────────

async function sweepIdleSandboxes(): Promise<void> {
  const cfg = sandboxConfig();
  const idleMs = (cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  let states: string[] = [];
  try {
    states = existsSync(STATE_DIR) ? readdirSync(STATE_DIR) : [];
  } catch {
    return;
  }
  for (const f of states) {
    if (!f.endsWith(".json")) continue;
    const state = readState(f.slice(0, -5));
    if (!state) continue;
    try {
      if ((await containerStatus(state.sandboxId)) !== "running") continue;
      // Idle = no active run for the session (host-registry has a live control
      // handle for every attached run) and no activity inside the window.
      if (hostRunBusy(state.sessionId)) continue;
      const last = Date.parse(state.lastActivityAt || state.createdAt) || 0;
      if (Date.now() - last < idleMs) continue;
      console.log(`[sandbox] stopping idle container ${state.sandboxId} (idle > ${idleMs / 60_000}m)`);
      await docker(["stop", "-t", "10", state.sandboxId], { timeoutMs: 60_000 });
    } catch (e) {
      console.warn(`[sandbox] idle sweep failed for ${state.sandboxId}:`, e);
    }
  }
}

/** Arm the idle-stop sweep once per process; parked on globalThis like the
 *  other schedulers so `bun --hot` reloads don't stack timers. */
function ensureIdleSweep(): void {
  const g = globalThis as any;
  if (g.__sandboxIdleSweepTimer) return;
  g.__sandboxIdleSweepTimer = setInterval(() => {
    void sweepIdleSandboxes();
  }, SWEEP_INTERVAL_MS);
}

// ── Provider ──────────────────────────────────────────────────────────────────

// Workspace resolution is delegated here so a cwd derived through the docker
// provider is byte-identical to the local provider's (and to the session
// paths' own resolution, which passes an already-resolved cwd in `spec.cwd`).
const localResolver = new LocalProvider();

/**
 * Serialize ensure() per session: two simultaneous ensures (e.g. a prompt and
 * a queued drain racing after a restart) would both see status "gone" and race
 * `docker create --name` — the loser errors and its turn falls back to the
 * host. Same in-process chain pattern as worktree.ts's withGitLock, parked on
 * globalThis so `bun --hot` reloads don't fork the chains.
 */
function withEnsureLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {
    __sandboxEnsureChains?: Map<string, Promise<unknown>>;
  };
  const chains = (g.__sandboxEnsureChains ??= new Map());
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(sessionId, tail);
  void tail.finally(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId);
  });
  return run;
}

export class DockerProvider implements SandboxProvider {
  readonly id = "docker" as const;

  /**
   * Create-or-reuse the session's container. The worktree itself is resolved
   * HOST-SIDE first (worktree creation, .env seeding, bun install all stay on
   * the host in Phase 1 — the container only ever sees the finished dir).
   */
  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withEnsureLock(spec.sessionId, () => this.ensureInner(spec));
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    ensureIdleSweep();
    const name = containerNameFor(spec.sessionId);
    const existing = readState(name);

    // Workspace mode. Sticky per sandbox: the state file's recorded mode wins
    // over a later config flip (a volume workspace's data lives in its volume
    // — re-binding it to a host path would orphan the work, and vice versa).
    // Volume applies only to workspaces with no host dir: an existing host
    // worktree (pre-existing session, shared workspace) stays bind-mounted.
    const repo = getRepo(spec.repo || existing?.repoId);
    const branch = spec.branch || existing?.branch;
    const canonical =
      spec.cwd || (branch ? worktreePathFor(branch, repo.id, { isolated: true }) : undefined);
    const wantVolume = existing?.workspace
      ? existing.workspace === "volume"
      : sandboxConfig().workspace === "volume";
    let workspace: "bind" | "volume";
    let cwd: string;
    if (wantVolume && canonical && !existsSync(canonical) && spec.mode !== "ask") {
      if (!branch) {
        throw new Error("volume-mode sandbox needs a branch to clone/check out");
      }
      workspace = "volume";
      cwd = canonical;
    } else {
      // Bind mode resolves the workspace HOST-SIDE first (worktree creation,
      // .env seeding, bun install all stay on the host — the container only
      // ever sees the finished dir).
      workspace = "bind";
      cwd = (await localResolver.ensure(spec)).cwd;
    }
    // A main checkout must never be bind-mounted rw into a sandbox as its
    // workspace: shared checkouts (backstage self-hosting) and repo mainlines
    // stay host-only forever (docs/sandboxes-plan.md §7.2). This also catches
    // the "falsy worktreeDir defaulted to the main checkout" session shape.
    if (isMainCheckout(cwd)) {
      throw new Error(
        `refusing to sandbox ${cwd}: it is a shared main checkout — docker sandboxes only run isolated worktrees`,
      );
    }
    const attachedDirs = [...new Set(spec.attachedDirs || existing?.attachedDirs || [])]
      .filter((d) => existsSync(d))
      .sort();
    if (workspace === "volume" && attachedDirs.length) {
      throw new Error(
        "attached repos are not supported in volume-mode sandboxes — detach them or use bind mode",
      );
    }

    let status = await containerStatus(name);
    if (
      status !== "gone" &&
      existing &&
      (existing.cwd !== cwd ||
        (existing.attachedDirs || []).join("\n") !== attachedDirs.join("\n"))
    ) {
      // The session's workspace moved (branch/worktree changed) or its
      // attached-repo set changed — the old container's mounts are stale.
      // Recreate it; the named volumes (engine state AND a volume-mode
      // workspace) survive `docker rm`.
      console.warn(`[sandbox] ${name}: mounts changed (${existing.cwd} → ${cwd}); recreating container`);
      await docker(["rm", "-f", name]);
      status = "gone";
    }
    if (status === "gone") {
      await createContainer(name, spec.sessionId, cwd, {
        workspace,
        attachedDirs,
        repo: workspace === "volume" ? repo : undefined,
      });
    }
    await ensureStarted(name);
    if (workspace === "volume") {
      await setupVolumeWorkspace(name, cwd, repo, branch!);
    }
    await setupContainer(name, cwd);
    writeState({
      sandboxId: name,
      sessionId: spec.sessionId,
      cwd,
      image: sandboxConfig().image || DEFAULT_IMAGE,
      createdAt: existing?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      workspace,
      repoId: repo.id,
      ...(branch ? { branch } : {}),
      ...(attachedDirs.length ? { attachedDirs } : {}),
    });
    return makeDockerSandbox(name, spec.sessionId, cwd, workspace);
  }

  /**
   * Reattach after a restart. A stopped container is fine (launchRun/exec
   * start it lazily); a REMOVED container is recreated from the provider's
   * state file when possible, since the volumes (engine state) outlive it.
   */
  async get(sandboxId: string): Promise<Sandbox | null> {
    ensureIdleSweep();
    const state = readState(sandboxId);
    const status = await containerStatus(sandboxId);
    if (status === "gone") {
      if (!state) return null;
      try {
        return await this.ensure({
          sessionId: state.sessionId,
          cwd: state.cwd,
          repo: state.repoId,
          branch: state.branch,
          attachedDirs: state.attachedDirs,
        });
      } catch (e) {
        console.warn(`[sandbox] could not recreate ${sandboxId}:`, e);
        return null;
      }
    }
    if (!state) {
      // Container exists but state was lost — recover what we can from labels.
      const r = await docker(["inspect", "-f", "{{index .Config.Labels \"backstage.session\"}}", sandboxId]);
      const sessionId = r.exitCode === 0 ? r.stdout.trim() : "";
      if (!sessionId) return null;
      const runs = await docker(["inspect", "-f", "{{range .Mounts}}{{.Source}}\n{{end}}", sandboxId]);
      // cwd is unknowable without state; refuse rather than guess.
      console.warn(`[sandbox] ${sandboxId} has no state file — exec-only reattach (mounts: ${runs.stdout.split("\n")[0] || "?"})`);
      return null;
    }
    return makeDockerSandbox(sandboxId, state.sessionId, state.cwd, state.workspace || "bind");
  }

  /** Tear down container + its named volumes + provider state. A bind-mode
   *  worktree is untouched (it belongs to the host's worktree lifecycle); a
   *  volume-mode WORKSPACE is deleted with its `-ws` volume — that data loss
   *  is the mode's documented contract (push your work). */
  async destroy(sandboxId: string): Promise<void> {
    await docker(["rm", "-f", sandboxId]);
    await docker([
      "volume", "rm", "-f",
      `${sandboxId}-claude`, `${sandboxId}-codex`, `${sandboxId}-ws`,
    ]);
    const state = readState(sandboxId);
    try {
      unlinkSync(statePath(sandboxId));
    } catch {}
    if (state) {
      try {
        rmSync(sessionRunsDir(state.sessionId), { recursive: true, force: true });
      } catch {}
    }
  }
}

// ── Restart-resume (called from agent-runner's resumeInterruptedRuns) ─────────

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Resume a journaled docker-sandbox run after a backstage restart.
 *
 *  1. If the in-container run host is STILL ALIVE (containers outlive the
 *     backstage process), reattach to its socket — nothing is re-prompted.
 *  2. If it ended while we were down, deliver its terminal event.
 *  3. Otherwise relaunch in the same sandbox with the standard continuation
 *     prompt against the journaled engine session.
 *
 * Returns null when the sandbox is gone and can't be recreated (the caller
 * logs it; the session's next user prompt will re-ensure a container).
 */
export async function resumeDockerSandboxRun(
  run: ActiveRunRecord,
  cb: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.sandboxId || !run.bksSessionId) return null;
  const provider = new DockerProvider();
  const sandbox = await provider.get(run.sandboxId);
  if (!sandbox) return null;

  const launcher = makeDockerLauncher(run.sandboxId, run.bksSessionId);
  const oldDir = launcher.newRunDir(run.runKey);
  const oldSpec = readJsonSafe<RunHostSpec>(`${oldDir}/${HOST_SPEC_NAME}`);
  if (oldSpec) {
    const meta = readJsonSafe<RunHostMeta>(`${oldDir}/${HOST_META_NAME}`);
    if (meta?.done) {
      // Ended while backstage was down: hand the terminal event to the normal
      // consumption bookkeeping, then clean up.
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {}
      const done = meta.done;
      return (async function* () {
        yield done;
      })();
    }
    if ((await containerStatus(run.sandboxId)) === "running" && (await launcher.alive(oldDir, meta))) {
      if (oldSpec.rpcToken) {
        registerRunToken(oldSpec.rpcToken, { sessionId: oldSpec.bksSessionId, user: oldSpec.user });
      }
      console.log(`[sandbox] reattaching to live run ${run.runKey} in ${run.sandboxId}`);
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher);
      await handle.connectWithWait(15_000);
      return withRunJournal(handle.events(), { ...run, startedAt: run.startedAt });
    }
  }

  // Host process died with (or before) the restart — relaunch a continuation
  // in the same sandbox so the engine session's in-container state is reused.
  const prompt = run.claudeSessionId ? RESUME_CONTINUATION_PROMPT : run.prompt;
  if (!prompt) return null;
  const rpcToken = oldSpec?.proxyMcpServers?.length ? crypto.randomUUID() : undefined;
  if (rpcToken) registerRunToken(rpcToken, { sessionId: run.bksSessionId, user: run.user });
  const spec: RunHostSpec = {
    hostId: `rh-${Bun.randomUUIDv7()}`,
    bksSessionId: run.bksSessionId,
    prompt,
    engineSessionId: run.claudeSessionId,
    cwd: run.cwd,
    mode: run.mode,
    model: run.model,
    mcpServers: run.mcpServers,
    proxyMcpServers: oldSpec?.proxyMcpServers,
    rpcToken,
    reposNote: oldSpec?.reposNote,
    deniedTools: run.deniedTools,
    confirmTools: run.confirmTools,
    aws: run.aws,
    author: oldSpec?.author,
    user: run.user,
    fallbackModel: run.fallbackModel,
    effort: run.effort,
    accountId: run.accountId,
    accountStrict: run.accountStrict,
    usageCredits: run.usageCredits,
    journalKind: `${run.kind || "prompt"}-resume`,
  };
  try {
    if (oldDir && existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  } catch {}
  console.log(`[sandbox] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`);
  return sandbox.launchRun(spec, { onAskUser: cb.onAskUser }).events();
}
