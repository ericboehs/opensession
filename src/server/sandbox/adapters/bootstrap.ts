/**
 * bootstrap — shared runtime for the REMOTE sandbox adapters (Daytona, E2B;
 * docs/sandboxes-plan.md §5 Phase 3). Everything here is provider-agnostic:
 * the adapters implement the small `RemoteDriver` wire (shell exec, detached
 * exec, file write, wake) and get, in return:
 *
 *  - `bootstrapRemoteSandbox`: remote sandboxes don't run our prebaked
 *    backstage-runner image, so first ensure installs the runner payload
 *    in-sandbox — bun, the backstage repo bundle (config `runnerBundleUrl`
 *    tarball, or a git clone of `runnerRepoUrl`/this checkout's origin at
 *    `runnerSha`), `bun install`, and the Claude Code CLI — all under
 *    /home/ubuntu so the runner's hardcoded absolute paths (claude CLI, repo
 *    bundle, HOST_ENTRY) resolve exactly like they do on the host and in the
 *    docker image (path parity is the contract; see deploy/sandbox/README.md).
 *    COLD-START COST: several minutes on the first ensure of a fresh sandbox
 *    (bun install pulls the full dep tree incl. the ~223MB vendored codex
 *    binary). The fast path — Daytona snapshots / E2B custom templates with
 *    the payload prebaked — is a documented follow-up, not built here; a
 *    `.bks-bootstrapped` marker makes every later ensure a no-op.
 *  - `setupRemoteWorkspace`: remote workspaces are ALWAYS volume-style — the
 *    repo is cloned INSIDE the sandbox from its https origin (never a host
 *    mount). Auth comes from config `cloneCredential` ({type:"none"} public /
 *    {type:"https-token", token} injected into the URL) — host git/ssh creds
 *    are never uploaded. Destroying the sandbox destroys the workspace: push
 *    your work (same contract as docker volume mode).
 *  - `makeRemoteSandbox` / `makeRemoteLauncher`: the Sandbox handle whose
 *    launchRun starts HOST_ENTRY in-sandbox with the WS-transport env — the
 *    sandbox dials back to `callbackBaseUrl`'s /backstage/run-ws route (there
 *    is no socket option remotely), and the michael-* MCP proxies dial
 *    /backstage/rpc-ws. Run dirs use the SAME absolute path host-side and
 *    in-sandbox: spec.json is mirrored host-side (so restart-resume can
 *    re-register tokens), while meta/journal/log live only in the sandbox.
 *  - `resumeRemoteSandboxRun`: restart-resume mirroring the docker path —
 *    reattach to a still-alive in-sandbox host via its WS redial, or relaunch
 *    a continuation. One gap vs docker: meta.json isn't host-visible, so a
 *    run that ENDED while backstage was down is resumed as a continuation
 *    (engine session preserved) instead of having its terminal event
 *    consumed.
 *
 * Credential trust note: a SCOPED slice of `~/.backstage-claude-accounts.json`
 * (Claude OAuth pool) is uploaded into the sandbox per LAUNCH (not at
 * bootstrap): only the run's pinned account when spec.accountId is set, else
 * the shared pool accounts plus the run user's own personal accounts — never
 * another user's personal subscription (accountsForRemoteUpload,
 * claude-accounts.ts). That's deliberately narrower than the docker
 * provider's ro mount of the full store, because this is third-party compute;
 * a self-hoster who doesn't accept even the scoped upload runs these adapters
 * against their OWN Daytona/E2B deployment (both are self-hostable).
 * Automations are refused sandboxing elsewhere in the stack, so only
 * interactive-trust runs get here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "fs";
import { dirname } from "path";
import { BACKSTAGE_CHATS_DIR } from "../../paths";
import {
  journalSet,
  journalClear,
  type ActiveRunRecord,
  type StreamEvent,
} from "../../claude-runner";
import { RESUME_CONTINUATION_PROMPT } from "../../agent-runner";
import { accountsForRemoteUpload } from "../../claude-accounts";
import { providerFor } from "../../models";
import { hostSteer, hostInterruptSteer, hostCancel } from "../../host-registry";
import { registerRunToken, unregisterRunToken } from "../../run-rpc";
import { registerRunWsHost, unregisterRunWsHost, runWsConnector } from "../../run-ws";
import { writeJsonAtomic } from "../../shared/atomic-write";
import { HostHandle, type HandleCallbacks, type HostLauncher } from "../../host-client";
import {
  HOST_SPEC_NAME,
  HOST_ENTRY,
  REPO_ROOT,
  type RunHostSpec,
} from "../../../runner-host/protocol";
import { sandboxConfig, sandboxCallbackBaseUrl } from "../config";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProviderId,
  SandboxStatus,
} from "../provider";

/** Absolute paths INSIDE the sandbox — kept byte-identical to the host/docker
 *  layout so the runner's hardcoded paths resolve (do not "tidy" these). */
export const REMOTE_HOME = "/home/ubuntu";
export const REMOTE_BUN = `${REMOTE_HOME}/.bun/bin/bun`;
export const REMOTE_CLAUDE = `${REMOTE_HOME}/.local/bin/claude`;
export const REMOTE_REPO = REPO_ROOT; // /home/ubuntu/projects/tella-backstage
const BOOTSTRAP_MARKER = `${REMOTE_HOME}/.bks-bootstrapped`;
const REMOTE_PATH = `${REMOTE_HOME}/.bun/bin:${REMOTE_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

const RUNS_BASE = `${BACKSTAGE_CHATS_DIR}/sandbox-runs`;
const STATE_DIR = `${BACKSTAGE_CHATS_DIR}/sandboxes`;

// ── The wire each adapter implements ─────────────────────────────────────────

export interface RemoteExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RemoteDriver {
  /** One-shot SHELL command (a string — adapters' SDKs take shell strings;
   *  argv callers go through shellQuote). Never throws on non-zero exit. */
  exec(cmd: string, opts?: RemoteExecOpts): Promise<ExecResult>;
  /** Start a detached long-lived process that survives this call AND this
   *  backstage process (provider background/session APIs). */
  execBackground(cmd: string, opts?: RemoteExecOpts): Promise<void>;
  /** Write a file into the sandbox (parent dir must exist). */
  writeFile(path: string, content: string): Promise<void>;
  /** Wake a stopped/paused sandbox — control-plane ops only, never reads. */
  ensureStarted(): Promise<void>;
}

// ── Small shell helpers ───────────────────────────────────────────────────────

/** POSIX-quote one argv word. */
export function shellQuoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** argv → a shell string with every word quoted (argv semantics preserved
 *  through the providers' shell-string exec APIs). */
export function shellQuote(argv: string[]): string {
  return argv.map(shellQuoteWord).join(" ");
}

function envPrefix(env: Record<string, string>): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shellQuoteWord(v)}`);
  return parts.length ? `env ${parts.join(" ")} ` : "";
}

/** Strip credentials from https URLs before they reach logs/errors. */
export function redactUrl(s: string): string {
  return s.replace(/(https?:\/\/)[^@/\s]+@/g, "$1");
}

// ── Provider state files (mirror docker's, namespaced per provider) ──────────

export interface RemoteSandboxState {
  sandboxId: string;
  provider: SandboxProviderId;
  sessionId: string;
  cwd: string;
  repoId?: string;
  branch?: string;
  createdAt: string;
  lastActivityAt: string;
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
}

function statePath(provider: string, sandboxId: string): string {
  return `${STATE_DIR}/${provider}-${sanitizeName(sandboxId)}.json`;
}

export function readRemoteState(
  provider: string,
  sandboxId: string,
): RemoteSandboxState | null {
  try {
    const p = statePath(provider, sandboxId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function writeRemoteState(state: RemoteSandboxState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(statePath(state.provider, state.sandboxId), state);
}

export function removeRemoteState(provider: string, sandboxId: string): void {
  const state = readRemoteState(provider, sandboxId);
  try {
    unlinkSync(statePath(provider, sandboxId));
  } catch {}
  if (state) {
    try {
      rmSync(`${RUNS_BASE}/${sanitizeName(state.sessionId)}`, { recursive: true, force: true });
    } catch {}
  }
}

export function touchRemoteState(provider: string, sandboxId: string): void {
  const s = readRemoteState(provider, sandboxId);
  if (s) {
    s.lastActivityAt = new Date().toISOString();
    writeRemoteState(s);
  }
}

/** Find a provider's state file by session id (the reverse index ensure needs
 *  when the provider-side label lookup fails). */
export function findRemoteStateBySession(
  provider: string,
  sessionId: string,
): RemoteSandboxState | null {
  try {
    if (!existsSync(STATE_DIR)) return null;
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.startsWith(`${provider}-`) || !f.endsWith(".json")) continue;
      try {
        const s: RemoteSandboxState = JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf-8"));
        if (s.sessionId === sessionId) return s;
      } catch {}
    }
  } catch {}
  return null;
}

/** Serialize ensure() per provider+session — same in-process chain pattern as
 *  docker's withEnsureLock, parked on globalThis for --hot survival. */
export function withRemoteEnsureLock<T>(
  provider: string,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as unknown as {
    __remoteSandboxEnsureChains?: Map<string, Promise<unknown>>;
  };
  const chains = (g.__remoteSandboxEnsureChains ??= new Map());
  const key = `${provider}:${sessionId}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  void tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// ── Clone URL resolution ──────────────────────────────────────────────────────

async function hostGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return code === 0 ? out.trim() : "";
}

function toHttpsUrl(origin: string): string | null {
  if (/^https:\/\//.test(origin)) return origin;
  // git@github.com:owner/name(.git) → https://github.com/owner/name.git
  const m = origin.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}.git`;
  const ssh = origin.match(/^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
  return null;
}

function injectToken(httpsUrl: string): string {
  const cred = sandboxConfig().cloneCredential;
  if (cred?.type === "https-token" && cred.token) {
    return httpsUrl.replace(/^https:\/\//, `https://x-access-token:${cred.token}@`);
  }
  return httpsUrl;
}

/**
 * The https clone URL a remote sandbox uses for a repo: an https origin (or
 * ssh origin converted), else derived from `ghRepo`. Local-path origins are
 * unreachable remotely — loud error. `cloneCredential` is applied here.
 */
export async function remoteCloneUrl(repo: {
  id: string;
  repo: string;
  ghRepo?: string;
}): Promise<string> {
  const origin = await hostGit(["remote", "get-url", "origin"], repo.repo);
  const https = (origin && toHttpsUrl(origin)) || (repo.ghRepo ? `https://github.com/${repo.ghRepo}.git` : null);
  if (!https) {
    throw new Error(
      `repo ${repo.id} has no https-reachable origin (origin="${redactUrl(origin) || "none"}") — remote sandboxes clone over https; set an origin or ghRepo`,
    );
  }
  return injectToken(https);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function need(r: ExecResult, what: string): void {
  if (r.exitCode !== 0) {
    throw new Error(
      `remote sandbox bootstrap failed (${what}): ${redactUrl((r.stderr || r.stdout).trim().slice(0, 500))}`,
    );
  }
}

/**
 * Install the runner payload in a fresh remote sandbox (idempotent — a marker
 * file short-circuits every later call). See the module header for what/why
 * and the cold-start cost.
 */
export async function bootstrapRemoteSandbox(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  const cfg = sandboxConfig();
  const signature = cfg.runnerSha || cfg.runnerBundleUrl || "unpinned";
  const marker = await driver.exec(`cat ${BOOTSTRAP_MARKER} 2>/dev/null`);
  if (marker.exitCode === 0 && marker.stdout.trim() === signature) return;
  const log = (msg: string) => console.log(`[sandbox:${label}] bootstrap: ${msg}`);

  // /home/ubuntu must exist and be ours — the runner's absolute paths live
  // under it regardless of the image's default user (E2B "base" runs as
  // `user`, Daytona images vary; both ship passwordless sudo by default).
  need(
    await driver.exec(
      `test -w ${REMOTE_HOME} || (sudo -n mkdir -p ${REMOTE_HOME} && sudo -n chown $(id -u):$(id -g) ${REMOTE_HOME})`,
    ),
    `writable ${REMOTE_HOME} (image needs passwordless sudo or a prebaked /home/ubuntu)`,
  );
  need(await driver.exec("command -v curl"), "curl present in the image");
  // bun's installer needs unzip; best-effort apt when missing.
  const unzip = await driver.exec(
    "command -v unzip || (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq unzip)",
    { timeoutMs: 180_000 },
  );
  if (unzip.exitCode !== 0) log("unzip install failed — bun install may fail");

  log("installing bun…");
  need(
    await driver.exec(
      `test -x ${REMOTE_BUN} || curl -fsSL https://bun.sh/install | HOME=${REMOTE_HOME} bash`,
      { timeoutMs: 300_000 },
    ),
    "bun install",
  );

  // Runner bundle: tarball if configured, else git clone at the pinned sha.
  const hasRepo = await driver.exec(`test -f ${REMOTE_REPO}/package.json`);
  if (hasRepo.exitCode !== 0) {
    if (cfg.runnerBundleUrl) {
      log(`fetching runner bundle from ${redactUrl(cfg.runnerBundleUrl)}…`);
      need(
        await driver.exec(
          `mkdir -p ${REMOTE_REPO} && curl -fsSL ${shellQuoteWord(cfg.runnerBundleUrl)} | tar -xz --strip-components=1 -C ${REMOTE_REPO}`,
          { timeoutMs: 600_000 },
        ),
        "runner bundle download",
      );
    } else {
      const backstageRepo = { id: "backstage", repo: REPO_ROOT, ghRepo: undefined };
      const url =
        cfg.runnerRepoUrl && toHttpsUrl(cfg.runnerRepoUrl)
          ? injectToken(toHttpsUrl(cfg.runnerRepoUrl)!)
          : await remoteCloneUrl(backstageRepo);
      log(`cloning runner repo ${redactUrl(url)}…`);
      need(
        await driver.exec(
          `mkdir -p ${dirname(REMOTE_REPO)} && git clone -- ${shellQuoteWord(url)} ${REMOTE_REPO}`,
          { timeoutMs: 600_000 },
        ),
        "runner repo clone",
      );
    }
  }

  // Reconcile the checkout with the pinned runnerSha — OUTSIDE the clone block,
  // so it also runs when the repo already exists. (A runnerSha bump used to be
  // silently skipped on an already-bootstrapped sandbox: the `test -f
  // package.json` guard short-circuited the fetch/checkout, yet the signature
  // marker below was rewritten, freezing the old code forever.) The marker is
  // only written after the checkout verifiably matches the pin.
  if (cfg.runnerSha) {
    const isGit = await driver.exec(`test -d ${REMOTE_REPO}/.git`);
    if (isGit.exitCode !== 0) {
      // Tarball payload (runnerBundleUrl) — no git history to reconcile; the
      // signature marker keys on the sha, so a bump with a stale bundle keeps
      // re-running bootstrap loudly instead of pretending it applied.
      log(`runnerSha ${cfg.runnerSha} pinned but ${REMOTE_REPO} is not a git checkout — skipping reconcile`);
    } else {
      const head = async () =>
        (await driver.exec(`git -C ${REMOTE_REPO} rev-parse HEAD`)).stdout.trim();
      const resolvePin = async () =>
        (
          await driver.exec(
            `git -C ${REMOTE_REPO} rev-parse --verify --quiet ${shellQuoteWord(`${cfg.runnerSha}^{commit}`)}`,
          )
        ).stdout.trim();
      let pin = await resolvePin();
      if (!pin || (await head()) !== pin) {
        log(`checking out pinned runnerSha ${cfg.runnerSha}…`);
        need(
          await driver.exec(
            `git -C ${REMOTE_REPO} fetch --depth 1 origin ${shellQuoteWord(cfg.runnerSha)} 2>/dev/null; git -C ${REMOTE_REPO} checkout --detach ${shellQuoteWord(cfg.runnerSha)}`,
            { timeoutMs: 300_000 },
          ),
          `checkout of pinned runnerSha ${cfg.runnerSha}`,
        );
        pin = await resolvePin();
        const now = await head();
        if (!pin || now !== pin) {
          throw new Error(
            `remote sandbox bootstrap failed: checkout landed on ${now || "unknown"}, not pinned runnerSha ${cfg.runnerSha}`,
          );
        }
      }
    }
  }

  log("bun install (this is the slow part — several minutes cold)…");
  need(
    await driver.exec(`cd ${REMOTE_REPO} && HOME=${REMOTE_HOME} ${REMOTE_BUN} install`, {
      timeoutMs: 900_000,
    }),
    "bun install of the runner bundle",
  );

  log("installing claude CLI…");
  need(
    await driver.exec(
      `test -x ${REMOTE_CLAUDE} || curl -fsSL https://claude.ai/install.sh | HOME=${REMOTE_HOME} bash`,
      { timeoutMs: 300_000 },
    ),
    "claude CLI install",
  );
  need(
    await driver.exec(
      `mkdir -p ${REMOTE_HOME}/.claude && { test -s ${REMOTE_HOME}/.claude/settings.json || printf '{}' > ${REMOTE_HOME}/.claude/settings.json; }`,
    ),
    "~/.claude seed",
  );

  // NOTE: the Claude account pool is NOT uploaded here. Bootstrap is per
  // sandbox and knows nothing about the run, so it used to ship the FULL
  // store — including other users' personal subscriptions — to third-party
  // compute. The scoped upload now happens per launch in makeRemoteLauncher
  // (see the module header's credential note).

  need(
    await driver.exec(`printf '%s' ${shellQuoteWord(signature)} > ${BOOTSTRAP_MARKER}`),
    "bootstrap marker",
  );
  log("done");
}

// ── Workspace (always volume-style: cloned inside the sandbox) ───────────────

export async function setupRemoteWorkspace(
  driver: RemoteDriver,
  cwd: string,
  cloneUrl: string,
  branch: string,
  defaultBranch: string,
): Promise<void> {
  const cloned = await driver.exec(`test -d ${shellQuoteWord(cwd)}/.git`);
  if (cloned.exitCode !== 0) {
    console.log(`[sandbox-remote] cloning ${redactUrl(cloneUrl)} into ${cwd}`);
    const clone = await driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(cwd))} && git clone -- ${shellQuoteWord(cloneUrl)} ${shellQuoteWord(cwd)}`,
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`remote workspace clone failed: ${redactUrl(clone.stderr.trim().slice(0, 500))}`);
    }
  }
  const cur = await driver.exec("git branch --show-current", { cwd });
  if (cur.exitCode === 0 && cur.stdout.trim() === branch) return;
  const hasRemote = await driver.exec(
    `git rev-parse --verify --quiet origin/${shellQuoteWord(branch)}`,
    { cwd },
  );
  const startPoint = hasRemote.exitCode === 0 ? `origin/${branch}` : `origin/${defaultBranch}`;
  const co = await driver.exec(
    `git checkout -B ${shellQuoteWord(branch)} ${shellQuoteWord(startPoint)}`,
    { cwd },
  );
  if (co.exitCode !== 0) {
    throw new Error(
      `remote workspace checkout -B ${branch} ${startPoint} failed: ${co.stderr.trim().slice(0, 300)}`,
    );
  }
}

// ── Run launching (WS transport only — there is no socket option remotely) ───

function sessionRunsDir(sessionId: string): string {
  return `${RUNS_BASE}/${sanitizeName(sessionId)}`;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * HostLauncher over a RemoteDriver. Run-dir paths are identical host-side and
 * in-sandbox: spec.json exists in BOTH (host mirror feeds restart-resume;
 * the in-sandbox copy feeds HOST_ENTRY), meta/journal/log are sandbox-only.
 */
export function makeRemoteLauncher(driver: RemoteDriver, sessionId: string): HostLauncher {
  return {
    async alive(dir) {
      const meta = await driver.exec(`cat ${shellQuoteWord(`${dir}/meta.json`)} 2>/dev/null`);
      if (meta.exitCode !== 0) return false;
      let pid = 0;
      try {
        pid = Number(JSON.parse(meta.stdout)?.pid) || 0;
      } catch {}
      if (!pid) return false;
      return (await driver.exec(`kill -0 ${pid}`)).exitCode === 0;
    },
    newRunDir: (hostId) => `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    connector: (_dir, spec) => (spec.wsToken ? runWsConnector(spec.hostId) : undefined),
    async writeSpec(dir, spec) {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec); // host mirror (resume)
      const mk = await driver.exec(`mkdir -p ${shellQuoteWord(dir)}`);
      if (mk.exitCode !== 0) {
        throw new Error(`remote run dir create failed: ${mk.stderr.trim().slice(0, 300)}`);
      }
      await driver.writeFile(`${dir}/${HOST_SPEC_NAME}`, JSON.stringify(spec));
    },
    async launch(hostId, dir) {
      const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
      if (!spec?.wsToken) {
        throw new Error(`remote launch of ${hostId}: spec.json (with wsToken) missing from ${dir}`);
      }
      await driver.ensureStarted();
      // Scoped Claude account upload — only what THIS run may use (pinned
      // account, else pool + the run user's own personal accounts; see the
      // module header). Rewritten every launch so pin/user changes apply and
      // a previously-uploaded wider file never lingers.
      const accounts = accountsForRemoteUpload(spec.user, spec.accountId);
      await driver.writeFile(
        `${REMOTE_HOME}/.backstage-claude-accounts.json`,
        JSON.stringify({ accounts }, null, 2) + "\n",
      );
      await driver.exec(`chmod 600 ${REMOTE_HOME}/.backstage-claude-accounts.json`);
      const base = sandboxCallbackBaseUrl();
      registerRunWsHost(hostId, spec.wsToken);
      try {
        const env: Record<string, string> = {
          HOME: REMOTE_HOME,
          PATH: REMOTE_PATH,
          NODE_ENV: "production",
          BACKSTAGE_RUN_JOURNAL: `${dir}/journal.json`,
          BKS_RUN_WS_URL: `${base}/backstage/run-ws/${hostId}`,
          BKS_RUN_WS_TOKEN: spec.wsToken,
          BKS_RPC_WS_URL: `${base}/backstage/rpc-ws`,
          ...(process.env.MICHAEL_MODEL ? { MICHAEL_MODEL: process.env.MICHAEL_MODEL } : {}),
        };
        await driver.execBackground(
          `${envPrefix(env)}${REMOTE_BUN} run ${HOST_ENTRY} ${dir}/${HOST_SPEC_NAME} >> ${dir}/host.log 2>&1`,
        );
      } catch (e) {
        unregisterRunWsHost(hostId);
        throw e;
      }
    },
  };
}

// ── Journal bookkeeping (backstage side; mirrors docker's) ────────────────────

function recordForSpec(
  spec: RunHostSpec,
  sandboxId: string,
  provider: SandboxProviderId,
): ActiveRunRecord {
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
    sandboxProvider: provider,
    kind: spec.journalKind || "prompt",
    startedAt: new Date().toISOString(),
  };
}

async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
  touch: () => void,
): AsyncGenerator<StreamEvent> {
  journalSet(record);
  touch();
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
    touch();
  }
}

// ── The Sandbox handle ────────────────────────────────────────────────────────

export interface RemoteSandboxParts {
  providerId: SandboxProviderId;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  driver: RemoteDriver;
  ports(): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
  /** Activity ping (state file + provider-native keepalive, e.g. E2B's
   *  countdown extension). Called at run start/end. */
  touchActivity(): void | Promise<void>;
}

/** Internal accessor resume uses to reach a handle's driver/launcher. */
const remoteParts = new WeakMap<object, { driver: RemoteDriver; launcher: HostLauncher }>();

export function makeRemoteSandbox(parts: RemoteSandboxParts): Sandbox {
  const launcher = makeRemoteLauncher(parts.driver, parts.sessionId);
  const touch = () => {
    try {
      void parts.touchActivity();
    } catch {}
  };
  const sandboxHandle: Sandbox = {
    id: parts.sandboxId,
    provider: parts.providerId,
    cwd: parts.cwd,
    workspace: "volume",

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      await parts.driver.ensureStarted();
      return parts.driver.exec(shellQuote(cmd), { cwd: parts.cwd, env: opts?.env });
    },

    async launchRunEager(spec: RunHostSpec, cb?: RunHandleCallbacks): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      spec.wsToken ??= crypto.randomUUID(); // remote runs are always WS
      const record = recordForSpec(spec, parts.sandboxId, parts.providerId);
      let handle: HostHandle | undefined;
      try {
        await launcher.writeSpec!(dir, spec);
        await launcher.launch(spec.hostId, dir);
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await handle.connectWithWait(45_000);
      } catch (e) {
        handle?.abandon();
        unregisterRunToken(spec.rpcToken);
        unregisterRunWsHost(spec.hostId);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        throw e;
      }
      const gen = withRunJournal(handle.events(), record, touch);
      return {
        events: () => gen,
        steerable: providerFor(spec.model) !== "codex",
        steer: (text) => hostSteer(spec.bksSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.bksSessionId, text),
        cancel: () => hostCancel(spec.bksSessionId),
      };
    },

    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
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

    ports: () => parts.ports(),
    status: () => parts.status(),
  };
  remoteParts.set(sandboxHandle, { driver: parts.driver, launcher });
  return sandboxHandle;
}

// ── Restart-resume (mirrors resumeDockerSandboxRun; see module header for
//    the meta.json gap) ────────────────────────────────────────────────────────

export async function resumeRemoteSandboxRun(
  run: ActiveRunRecord,
  cb: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.sandboxId || !run.bksSessionId || !run.sandboxProvider) return null;
  // Lazy to avoid a static import cycle (index → adapters → bootstrap).
  const { getSandboxProvider } = await import("../index");
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await getSandboxProvider(run.sandboxProvider).get(run.sandboxId);
  } catch (e) {
    console.warn(`[sandbox-remote] resume: provider.get(${run.sandboxId}) failed:`, e);
  }
  if (!sandbox) return null;
  const parts = remoteParts.get(sandbox);
  if (!parts) return null;
  const { driver, launcher } = parts;

  const oldDir = launcher.newRunDir(run.runKey);
  const oldSpec = readJsonSafe<RunHostSpec>(`${oldDir}/${HOST_SPEC_NAME}`);
  if (oldSpec?.wsToken) {
    // Ended while we were down? meta.json lives in-sandbox only.
    const meta = await driver.exec(`cat ${shellQuoteWord(`${oldDir}/meta.json`)} 2>/dev/null`);
    let done: StreamEvent | undefined;
    try {
      done = meta.exitCode === 0 ? JSON.parse(meta.stdout)?.done : undefined;
    } catch {}
    if (done) {
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {}
      const terminal = done;
      return (async function* () {
        yield terminal;
      })();
    }
    if ((await sandbox.status()) === "running" && (await launcher.alive(oldDir, null))) {
      if (oldSpec.rpcToken) {
        registerRunToken(oldSpec.rpcToken, { sessionId: oldSpec.bksSessionId, user: oldSpec.user });
      }
      registerRunWsHost(oldSpec.hostId, oldSpec.wsToken);
      console.log(`[sandbox-remote] reattaching to live run ${run.runKey} in ${run.sandboxId}`);
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher);
      try {
        // The host redials with ≤5s backoff once its token is re-registered.
        await handle.connectWithWait(20_000);
      } catch (e) {
        handle.abandon();
        throw e;
      }
      return withRunJournal(handle.events(), { ...run, startedAt: run.startedAt }, () => {});
    }
  }

  // Host died with (or before) the restart — relaunch a continuation in the
  // same sandbox so the engine session's in-sandbox state is reused.
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
  console.log(`[sandbox-remote] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`);
  return sandbox.launchRun(spec, { onAskUser: cb.onAskUser }).events();
}
