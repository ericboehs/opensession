/**
 * Preview pool: warm, already-booted dev-server containers per repo, so the
 * session Preview button serves in seconds instead of paying a cold `just dev`
 * boot (~1 min on tella-fusion).
 *
 * Shape (per pool-enabled repo):
 *  - One GOLDEN IMAGE (`bks-preview-golden-<repo>:latest`): the repo cloned
 *    INSIDE the container FS (never a host worktree — the closed-worktree
 *    cleanup cron reaps host worktrees parked at origin/main), deps installed,
 *    dev server booted once and route-warmed, then committed. Rebuilt on a
 *    schedule / on demand; warm boots from it take ~11s (vs ~100s truly cold).
 *  - N WARM CONTAINERS booted from the golden image: `running` of them live,
 *    `paused` of them `docker pause`d after warming (unpause is ~ms; a frozen
 *    container costs only RAM, ~2GB). Each publishes container port 3300 onto
 *    a host port from the normal webapp dev range (3100-3999) — that is what
 *    lets the EXISTING preview machinery (ss-based status, httpsPortFor's
 *    +6000 Caddy route, PREVIEW_URL) work unchanged.
 *  - CLAIM on preview start: pick a ready container (unpause if needed),
 *    refresh its AWS creds, sync the session worktree's diff into the
 *    workspace (HMR recompiles just the delta), and point the session's
 *    `.ports.conf` WEBAPP_PORT at the container's host port. From there the
 *    normal getPreviewStatus path sees a listening webapp and exposes the URL.
 *    A 2s sync loop keeps following the worktree while the preview is open.
 *
 * Hard-won boot lessons encoded here (2026-07-23 experiment):
 *  - `.ports.conf` must be COMPLETE before start.sh runs — a partial file
 *    leaves sibling services with empty ports and concurrently kills the boot.
 *  - The app resolves AWS creds via the `tella-dev` PROFILE (.envrc sets
 *    AWS_PROFILE, which makes the SDK v3 default chain SKIP env credentials),
 *    and start.sh's own profile-baking is gated on the aws CLI the runner
 *    image deliberately lacks — so we write ~/.aws/credentials in-container
 *    ourselves, and refresh it on claim/sweep (the vended creds are
 *    short-lived).
 *  - ReScript's watch.lock survives ungraceful kills and blocks the next boot
 *    ("A ReScript build is already running") — every boot cleans it first.
 *  - Wait-for-up polling must FAIL EARLY on dead boots (grep the log for
 *    `error: Recipe`, check the process), never poll a corpse to timeout.
 */

import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentAwsEnv } from "./aws-creds";
import { configuredRepos, type Repo } from "./config";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { isLocalProfile } from "./profile";
import { sandboxConfig } from "./sandbox/config";

// ── Config ───────────────────────────────────────────────────────────────────

export interface PreviewPoolRepoConfig {
  enabled: boolean;
  /** Warm containers kept RUNNING (default 1). */
  running: number;
  /** Additional warm containers kept PAUSED (default 1). */
  paused: number;
  cpus: number;
  memory: string;
  /** Rebuild the golden image when older than this (default 24h). */
  goldenIntervalHours: number;
}

const DEFAULTS: Omit<PreviewPoolRepoConfig, "enabled"> = {
  running: 1,
  paused: 1,
  cpus: 4,
  memory: "8g",
  goldenIntervalHours: 24,
};

function poolDir(): string {
  return join(OPENSESSION_CHATS_DIR, "preview-pool");
}

function configFile(): string {
  return join(poolDir(), "config.json");
}

export function previewPoolConfig(repoId: string): PreviewPoolRepoConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf-8"));
    const r = raw?.repos?.[repoId] ?? {};
    return {
      enabled: r.enabled === true,
      running: clampInt(r.running, 0, 4, DEFAULTS.running),
      paused: clampInt(r.paused, 0, 8, DEFAULTS.paused),
      cpus: clampInt(r.cpus, 1, 16, DEFAULTS.cpus),
      memory: typeof r.memory === "string" ? r.memory : DEFAULTS.memory,
      goldenIntervalHours: clampInt(r.goldenIntervalHours, 1, 24 * 7, DEFAULTS.goldenIntervalHours),
    };
  } catch {
    return { enabled: false, ...DEFAULTS };
  }
}

export function setPreviewPoolConfig(repoId: string, patch: Partial<PreviewPoolRepoConfig>): void {
  mkdirSync(poolDir(), { recursive: true });
  let raw: { repos?: Record<string, unknown> } = {};
  try {
    raw = JSON.parse(readFileSync(configFile(), "utf-8"));
  } catch {}
  raw.repos ??= {};
  raw.repos[repoId] = { ...(raw.repos[repoId] as object), ...patch };
  writeFileSync(configFile(), JSON.stringify(raw, null, 2));
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

// ── State ────────────────────────────────────────────────────────────────────

/** In-container workspace path (inside the golden image's FS). */
const WORKSPACE = "/home/ubuntu/preview-workspace";
const CONTAINER_PORT = 3300;
const POOL_LABEL = "bks-preview-pool";

interface PoolContainer {
  name: string;
  repoId: string;
  /** warming = boot in flight; ready = serving; paused = frozen warm spare;
   *  claimed = attached to a session worktree. */
  state: "warming" | "ready" | "paused" | "claimed";
  hostPort: number;
  /** origin/<default> sha the workspace was reset to at boot (sync base). */
  bootSha: string;
  createdAt: string;
  sessionWorktree?: string;
  claimedAt?: string;
}

interface PoolState {
  golden?: { sha: string; builtAt: string; lastError?: string };
  containers: Record<string, PoolContainer>;
}

function stateFile(repoId: string): string {
  return join(poolDir(), `state-${repoId}.json`);
}

function readState(repoId: string): PoolState {
  try {
    const s = JSON.parse(readFileSync(stateFile(repoId), "utf-8"));
    return { golden: s.golden, containers: s.containers ?? {} };
  } catch {
    return { containers: {} };
  }
}

function writeState(repoId: string, state: PoolState): void {
  mkdirSync(poolDir(), { recursive: true });
  const tmp = `${stateFile(repoId)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile(repoId));
}

function patchContainer(repoId: string, name: string, patch: Partial<PoolContainer> | null): void {
  const state = readState(repoId);
  if (patch === null) delete state.containers[name];
  else state.containers[name] = { ...state.containers[name], ...patch } as PoolContainer;
  writeState(repoId, state);
}

const g = globalThis as unknown as {
  __previewPoolTimer?: ReturnType<typeof setInterval>;
  __previewPoolBusy?: Map<string, Promise<void>>;
  __previewPoolSyncs?: Map<string, { timer: ReturnType<typeof setInterval>; mtimes: Map<string, number> }>;
};
const busy: Map<string, Promise<void>> = (g.__previewPoolBusy ??= new Map());
/** worktreeDir -> live sync loop. */
const syncs = (g.__previewPoolSyncs ??= new Map());

function goldenImage(repoId: string): string {
  return `bks-preview-golden-${repoId}`;
}

/**
 * Artifacts that MUST exist in a workspace after setup.sh for the app to
 * actually render — the golden build refuses to commit without them (their
 * absence only surfaces later as module-not-found crashes on page compile).
 */
const PROVISION_MARKERS: Record<string, string[]> = {
  "tella-fusion": [
    "packages/core/webapp/src/bindings/wasm-bindings/tella_wasm_bindings.js",
    "packages/core/render_engine/render_engine.wasm",
    "packages/core/render_engine/media_worker.wasm",
  ],
};

// ── Docker helpers ───────────────────────────────────────────────────────────

async function docker(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, timeoutMs);
  const collect = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => ({ ok: code === 0 && !timedOut, out: (out + err).trim() }));
  // Absolute backstop: stream reads can wedge after a kill — never let a
  // docker call hang the caller past its budget (bit us live 2026-07-23:
  // a timed-out in-container clone left the whole golden build stuck).
  const result = await Promise.race([
    collect,
    new Promise<{ ok: boolean; out: string }>((res) =>
      setTimeout(() => res({ ok: false, out: `docker ${args[0]} timed out after ${timeoutMs}ms` }), timeoutMs + 10_000),
    ),
  ]);
  clearTimeout(killer);
  if (timedOut) return { ok: false, out: `timed out after ${timeoutMs}ms: ${result.out.slice(-300)}` };
  return result;
}

async function dockerExec(name: string, script: string, timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return docker(["exec", name, "bash", "-c", script], timeoutMs);
}

async function containerRunning(name: string): Promise<"running" | "paused" | "gone"> {
  const r = await docker(["inspect", name, "--format", "{{.State.Status}}"]);
  if (!r.ok) return "gone";
  if (r.out.includes("paused")) return "paused";
  return r.out.includes("running") ? "running" : "gone";
}

/** A free host port in the webapp dev range, so httpsPortFor(+6000) applies. */
async function allocateHostPort(): Promise<number | null> {
  for (let i = 0; i < 25; i++) {
    const port = 3100 + Math.floor(Math.random() * 900);
    const raw = await $`ss -tlnH sport = :${port}`.quiet().nothrow().text();
    if (!raw.trim()) return port;
  }
  return null;
}

// ── Boot scripts (run inside the container) ─────────────────────────────────

function fullPortsConf(): string {
  // Fixed sibling ports are fine: every container has its own network ns.
  return [
    `WEBAPP_PORT=${CONTAINER_PORT}`,
    "INSTANT_PORT=5312",
    "WEBAPP_WORKFLOW_PORT=6412",
    "WEBAPP_EMAILS_PREVIEW_PORT=6518",
    "TEMPORAL_PORT=7312",
    "TEMPORAL_UI_PORT=8312",
    "",
  ].join("\n");
}

/**
 * Write the AWS profile file inside a running container (see module doc).
 * Both sections matter: `[tella-dev]` serves the booted app (.envrc sets
 * AWS_PROFILE=tella-dev via direnv), `[default]` serves docker-exec'd steps
 * like setup.sh's WASM S3 install, which run WITHOUT AWS_PROFILE — the
 * first golden build shipped without WASM because only tella-dev existed.
 */
async function refreshContainerCreds(name: string): Promise<boolean> {
  const env = await getAgentAwsEnv();
  if (!env.AWS_ACCESS_KEY_ID) return false;
  const section = [
    `aws_access_key_id = ${env.AWS_ACCESS_KEY_ID}`,
    `aws_secret_access_key = ${env.AWS_SECRET_ACCESS_KEY}`,
    ...(env.AWS_SESSION_TOKEN ? [`aws_session_token = ${env.AWS_SESSION_TOKEN}`] : []),
  ];
  const lines = ["[default]", ...section, "", "[tella-dev]", ...section, ""].join("\n");
  const region = env.AWS_REGION || "us-east-2";
  const r = await dockerExec(
    name,
    `mkdir -p ~/.aws && cat > ~/.aws/credentials <<'BKSEOF'\n${lines}\nBKSEOF\nprintf '[default]\\nregion = %s\\n[profile tella-dev]\\nregion = %s\\n' "${region}" "${region}" > ~/.aws/config && chmod 600 ~/.aws/credentials`,
  );
  return r.ok;
}

function cloneUrlFor(repo: Repo): string | null {
  if (!repo.ghRepo) return null;
  const cred = sandboxConfig().cloneCredential;
  if (cred?.type === "https-token" && cred.token) {
    return `https://x-access-token:${cred.token}@github.com/${repo.ghRepo}.git`;
  }
  return `https://github.com/${repo.ghRepo}.git`;
}

/** Boot preamble every warm/golden boot runs: lock cleanup + full ports.conf. */
const BOOT_PREP = [
  `cd ${WORKSPACE}`,
  // The committed image can carry a stale /tmp/boot.log from the golden
  // build's shutdown (its 'error: Recipe … signal 15' lines). start.sh's
  // redirect truncates it — but only after the git-advance step, and
  // waitForUp's early error grep reads the stale file in that window and
  // kills a healthy boot. Truncate FIRST.
  `: > /tmp/boot.log`,
  // ReScript watch.lock survives SIGKILL and blocks the next boot.
  `find . -maxdepth 6 -name watch.lock -not -path '*/node_modules/*' -delete 2>/dev/null || true`,
  `rm -f .ports/dev-pgid`,
].join(" && ");

/**
 * Wait for the in-container dev server to answer on the host port — with
 * failure exits: a dead boot (log shows a failed recipe / start.sh exited)
 * aborts immediately with the log tail instead of polling out the clock.
 */
async function waitForUp(
  name: string,
  hostPort: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let probes = 0;
  while (Date.now() < deadline) {
    const code = await httpCode(`http://127.0.0.1:${hostPort}/`, "localhost:3300", 5);
    if (code !== 0) return { ok: true, detail: `HTTP ${code}` };
    probes++;
    if (probes % 3 === 0) {
      if ((await containerRunning(name)) !== "running") {
        return { ok: false, detail: "container died" };
      }
      const log = await dockerExec(
        name,
        `sed 's/\\x1b\\[[0-9;]*m//g' /tmp/boot.log 2>/dev/null | grep -aE 'error: Recipe|Watcher exited|exited with code' | tail -3`,
      );
      if (log.out.includes("error: Recipe")) {
        const tail = await dockerExec(name, "tail -c 1500 /tmp/boot.log 2>/dev/null");
        return { ok: false, detail: `boot failed: ${log.out}\n${tail.out}` };
      }
    }
    await Bun.sleep(2000);
  }
  return { ok: false, detail: "timed out" };
}

async function httpCode(url: string, host: string, timeoutSec: number): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: { Host: host },
      signal: AbortSignal.timeout(timeoutSec * 1000),
      redirect: "manual",
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** Request the repo's warm routes so Turbopack pre-compiles them. */
async function warmRoutes(repo: Repo, hostPort: number): Promise<void> {
  let routes = ["/"];
  try {
    const raw = await dockerReadWorkspaceFile(repo, ".opensession/preview.json");
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed?.warmRoutes) && parsed.warmRoutes.length) routes = parsed.warmRoutes;
  } catch {}
  for (const r of routes) {
    await httpCode(`http://127.0.0.1:${hostPort}${r}`, "localhost:3300", 120);
  }
}

async function dockerReadWorkspaceFile(_repo: Repo, rel: string): Promise<string | null> {
  // Read from the host main checkout — same content, no container roundtrip.
  const repoRoot = _repo.repo;
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

// ── Golden image build ───────────────────────────────────────────────────────

async function originDefaultSha(repo: Repo): Promise<string | null> {
  await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.quiet().nothrow();
  const sha = (
    await $`git -C ${repo.repo} rev-parse origin/${repo.defaultBranch}`.quiet().nothrow().text()
  ).trim();
  return sha || null;
}

export async function refreshGoldenImage(repoId: string, force = false): Promise<void> {
  const existing = busy.get(`golden-${repoId}`);
  if (existing) return existing;
  const run = doRefreshGolden(repoId, force).finally(() => busy.delete(`golden-${repoId}`));
  busy.set(`golden-${repoId}`, run);
  return run;
}

async function doRefreshGolden(repoId: string, force: boolean): Promise<void> {
  const repo = configuredRepos()[repoId];
  if (!repo) return;
  const cfg = previewPoolConfig(repoId);
  if (!cfg.enabled && !force) return;
  const state = readState(repoId);
  const sha = await originDefaultSha(repo);
  if (!sha) return;
  const imageExists = (await docker(["image", "inspect", `${goldenImage(repoId)}:latest`])).ok;
  const ageMs = state.golden?.builtAt ? Date.now() - Date.parse(state.golden.builtAt) : Infinity;
  if (!force && imageExists && state.golden?.sha && ageMs < cfg.goldenIntervalHours * 3_600_000) {
    return;
  }
  const started = Date.now();
  const name = `bks-preview-goldenbuild-${repoId}`;
  const cloneUrl = cloneUrlFor(repo);
  console.log(`[preview-pool] ${repoId}: building golden image at ${sha.slice(0, 10)}`);
  const fail = async (msg: string) => {
    console.warn(`[preview-pool] ${repoId}: golden build failed: ${msg.slice(0, 800)}`);
    writeState(repoId, {
      ...readState(repoId),
      golden: { ...(readState(repoId).golden ?? { sha: "", builtAt: "" }), lastError: msg.slice(0, 500) },
    });
    await docker(["rm", "-f", name]);
  };

  try {
    await docker(["rm", "-f", name]);
    const run = await docker([
      "run", "-d", "--name", name,
      "--label", `${POOL_LABEL}=goldenbuild`,
      "-v", `${repo.repo}:/src:ro`,
      "-p", `127.0.0.1::${CONTAINER_PORT}`,
      "--cpus", String(cfg.cpus), "--memory", cfg.memory,
      "backstage-runner:latest", "sleep", "infinity",
    ]);
    if (!run.ok) return void (await fail(`docker run: ${run.out}`));

    // Workspace: clone from the RO-mounted host checkout (fast), then align
    // to origin/<default> over https so the golden never lags the remote.
    // Depth 1: the workspace never needs history (worktree->container sync is
    // computed host-side; the container only ever resets to a fetched tip).
    let r = await dockerExec(name, `git clone --depth 1 --branch ${repo.defaultBranch} file:///src ${WORKSPACE}`, 5 * 60_000);
    if (!r.ok) return void (await fail(`clone: ${r.out.slice(-500)}`));
    if (cloneUrl) {
      r = await dockerExec(
        name,
        `cd ${WORKSPACE} && git fetch --depth 1 ${JSON.stringify(cloneUrl)} ${repo.defaultBranch} && git reset --hard FETCH_HEAD`,
        5 * 60_000,
      );
      if (!r.ok) return void (await fail(`fetch/reset: ${r.out.slice(-500)}`));
    }
    const wsSha = (await dockerExec(name, `git -C ${WORKSPACE} rev-parse HEAD`)).out.trim();

    // Seed gitignored env files from the host checkout (same seeding the
    // session worktrees get — .env.local is required by start.sh).
    for (const rel of ["packages/core/webapp/.env.local", ".envrc"]) {
      const src = join(repo.repo, rel);
      if (!existsSync(src)) continue;
      await docker(["cp", src, `${name}:${WORKSPACE}/${rel}`]);
    }
    await dockerExec(name, `cat > ${WORKSPACE}/.ports.conf <<'EOF'\n${fullPortsConf()}EOF`);
    if (!(await refreshContainerCreds(name))) {
      console.warn(`[preview-pool] ${repoId}: no AWS creds available for golden build (WASM install may fail)`);
    }

    // One-shot provisioning via the repo's own lifecycle contract.
    const setup = await dockerExec(
      name,
      `cd ${WORKSPACE} && [ -f .opensession/setup.sh ] && BACKSTAGE_BOOT_MODE=fresh bash .opensession/setup.sh || true`,
      15 * 60_000,
    );
    if (setup.out.includes("ERROR:")) return void (await fail(`setup.sh: ${setup.out.slice(-500)}`));
    // setup.sh treats a failed WASM install as a non-fatal WARN, but a golden
    // without these artifacts boots into module-not-found crashes on first
    // page compile — verify hard instead of shipping a degraded image.
    for (const marker of PROVISION_MARKERS[repoId] ?? []) {
      const chk = await dockerExec(name, `test -e ${WORKSPACE}/${marker}`);
      if (!chk.ok) {
        return void (await fail(`provisioning incomplete: ${marker} missing after setup.sh (S3 WASM install failed? ${setup.out.slice(-300)})`));
      }
    }

    // Boot, wait (with failure exits), warm, stop cleanly.
    const inspect = await docker(["port", name, `${CONTAINER_PORT}/tcp`]);
    const hostPort = parseInt(inspect.out.match(/:(\d+)$/m)?.[1] ?? "", 10);
    if (!hostPort) return void (await fail(`no published port: ${inspect.out}`));
    await docker([
      "exec", "-d",
      "-e", `WEBAPP_PORT=${CONTAINER_PORT}`, "-e", "BACKSTAGE_BOOT_MODE=fresh",
      "-w", WORKSPACE, name,
      "bash", "-c", `${BOOT_PREP} && exec bash .opensession/start.sh > /tmp/boot.log 2>&1`,
    ]);
    const up = await waitForUp(name, hostPort, 5 * 60_000);
    if (!up.ok) return void (await fail(`boot: ${up.detail}`));
    await warmRoutes(repo, hostPort);
    // Route warming compiles real pages — if that crashed the dev tree
    // (e.g. missing artifacts), the image is broken; don't commit it.
    const post = await dockerExec(
      name,
      `grep -aE 'error: Recipe|fatal error' /tmp/boot.log | head -2; true`,
    );
    if (post.out.trim()) return void (await fail(`dev server died during route warming: ${post.out.slice(0, 300)}`));

    // Graceful stop so the image carries no dev-server runtime state.
    await dockerExec(
      name,
      `pkill -TERM -f 'start.sh|dev-services|next dev|concurrently' 2>/dev/null; sleep 5; pkill -KILL -f 'next dev|rescript' 2>/dev/null; ${BOOT_PREP}; rm -f /tmp/boot.log; true`,
      30_000,
    );
    await docker(["stop", "-t", "10", name], 30_000);
    // Committing an ~8GB layer is I/O-bound and can take many minutes when
    // the host is busy — a timeout here discards a fully verified build.
    const commit = await docker(["commit", name, `${goldenImage(repoId)}:new`], 15 * 60_000);
    if (!commit.ok) return void (await fail(`commit: ${commit.out}`));
    // Rotate: latest -> prev, new -> latest.
    await docker(["rmi", `${goldenImage(repoId)}:prev`]);
    await docker(["tag", `${goldenImage(repoId)}:latest`, `${goldenImage(repoId)}:prev`]);
    await docker(["tag", `${goldenImage(repoId)}:new`, `${goldenImage(repoId)}:latest`]);
    await docker(["rmi", `${goldenImage(repoId)}:new`]);
    await docker(["rm", "-f", name]);

    writeState(repoId, {
      ...readState(repoId),
      golden: { sha: wsSha || sha, builtAt: new Date().toISOString() },
    });
    console.log(
      `[preview-pool] ${repoId}: golden image ready at ${(wsSha || sha).slice(0, 10)} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    // Old-golden warm spares are stale — retire unclaimed ones so the pool
    // refills from the new image (claimed ones live until their preview ends).
    const st = readState(repoId);
    for (const [cname, c] of Object.entries(st.containers)) {
      if (c.state !== "claimed") await destroyContainer(repoId, cname);
    }
  } catch (e) {
    await fail(String((e as Error)?.message || e));
  }
}

// ── Warm containers ──────────────────────────────────────────────────────────

async function spawnWarmContainer(repo: Repo): Promise<void> {
  const cfg = previewPoolConfig(repo.id);
  const hostPort = await allocateHostPort();
  if (!hostPort) return console.warn(`[preview-pool] ${repo.id}: no free host port`);
  const name = `bks-preview-warm-${repo.id}-${Math.random().toString(36).slice(2, 8)}`;
  const { previewHost, httpsPortFor } = await import("./preview");
  const host = await previewHost();
  const previewUrl = `https://${host}:${httpsPortFor(hostPort)}`;
  const cloneUrl = cloneUrlFor(repo);

  patchContainer(repo.id, name, {
    name, repoId: repo.id, state: "warming", hostPort, bootSha: "", createdAt: new Date().toISOString(),
  });

  // Advance the workspace to current origin/<default> before boot so warm
  // containers never serve a stale golden tree (delta fetch — seconds).
  const advance = cloneUrl
    ? `(git fetch --depth 1 ${JSON.stringify(cloneUrl)} ${repo.defaultBranch} && git reset --hard FETCH_HEAD) || true && `
    : "";
  const run = await docker([
    "run", "-d", "--name", name,
    "--label", `${POOL_LABEL}=${repo.id}`,
    "-p", `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
    "--cpus", String(cfg.cpus), "--memory", cfg.memory,
    "-e", `WEBAPP_PORT=${CONTAINER_PORT}`,
    "-e", "BACKSTAGE_BOOT_MODE=snapshot-restore",
    "-e", `PREVIEW_URL=${previewUrl}`,
    // No AWS_* env: the app resolves creds via the tella-dev PROFILE (env is
    // skipped when AWS_PROFILE is set) — refreshContainerCreds writes it.
    "-w", WORKSPACE,
    `${goldenImage(repo.id)}:latest`,
    "bash", "-c",
    `${BOOT_PREP} && ${advance}exec bash .opensession/start.sh > /tmp/boot.log 2>&1`,
  ]);
  if (!run.ok) {
    patchContainer(repo.id, name, null);
    return console.warn(`[preview-pool] ${repo.id}: warm spawn failed: ${run.out.slice(-300)}`);
  }
  await refreshContainerCreds(name);
  const up = await waitForUp(name, hostPort, 4 * 60_000);
  if (!up.ok) {
    console.warn(`[preview-pool] ${repo.id}: warm boot failed (${up.detail.slice(0, 500)})`);
    return destroyContainer(repo.id, name);
  }
  const bootSha = (await dockerExec(name, `git -C ${WORKSPACE} rev-parse HEAD`)).out.trim();
  await warmRoutes(repo, hostPort);
  patchContainer(repo.id, name, { state: "ready", bootSha });
  console.log(`[preview-pool] ${repo.id}: warm container ${name} ready on :${hostPort} (${bootSha.slice(0, 10)})`);
}

async function destroyContainer(repoId: string, name: string): Promise<void> {
  await docker(["rm", "-f", name]);
  patchContainer(repoId, name, null);
}

/** Reconcile one repo's pool: docker truth vs state, then top up. */
async function ensurePool(repo: Repo): Promise<void> {
  const cfg = previewPoolConfig(repo.id);
  const state = readState(repo.id);

  // Reconcile against docker.
  for (const [name, c] of Object.entries(state.containers)) {
    const status = await containerRunning(name);
    if (status === "gone") {
      patchContainer(repo.id, name, null);
      continue;
    }
    if (c.state === "claimed" && c.sessionWorktree && !existsSync(c.sessionWorktree)) {
      await destroyContainer(repo.id, name); // session worktree is gone
      continue;
    }
    // A warming entry with no live boot (e.g. process restarted mid-boot).
    if (c.state === "warming" && Date.now() - Date.parse(c.createdAt) > 10 * 60_000) {
      await destroyContainer(repo.id, name);
    }
  }

  if (!cfg.enabled) {
    // Disabled: drain unclaimed warm containers.
    for (const [name, c] of Object.entries(readState(repo.id).containers)) {
      if (c.state !== "claimed") await destroyContainer(repo.id, name);
    }
    return;
  }

  if (!(await docker(["image", "inspect", `${goldenImage(repo.id)}:latest`])).ok) {
    return refreshGoldenImage(repo.id);
  }

  const fresh = readState(repo.id).containers;
  const ready = Object.values(fresh).filter((c) => c.state === "ready");
  const pausedList = Object.values(fresh).filter((c) => c.state === "paused");
  const warming = Object.values(fresh).filter((c) => c.state === "warming");

  // Keep `running` ready + `paused` frozen. Excess ready -> pause; shortfall
  // paused -> unpause the newest (cheap) or boot new ones.
  if (ready.length > cfg.running) {
    for (const c of ready.slice(cfg.running)) {
      if ((await docker(["pause", c.name])).ok) patchContainer(repo.id, c.name, { state: "paused" });
    }
  } else if (ready.length < cfg.running && pausedList.length > 0) {
    const c = pausedList[0];
    if ((await docker(["unpause", c.name])).ok) patchContainer(repo.id, c.name, { state: "ready" });
  } else if (ready.length + warming.length < cfg.running) {
    await spawnWarmContainer(repo);
  }

  const after = readState(repo.id).containers;
  const pausedNow = Object.values(after).filter((c) => c.state === "paused").length;
  const warmingNow = Object.values(after).filter((c) => c.state === "warming").length;
  const readyNow = Object.values(after).filter((c) => c.state === "ready").length;
  if (readyNow >= cfg.running && pausedNow + warmingNow < cfg.paused) {
    // Boot one more, the next sweep pauses it once ready (one per tick keeps
    // the sweep cheap and the host load bounded).
    await spawnWarmContainer(repo);
  }
}

// ── Claim / release (the preview integration surface) ───────────────────────

export interface PoolClaim {
  containerName: string;
  hostPort: number;
  repoId: string;
}

/** The active pool claim backing a worktree's preview, if any. */
export function poolClaimFor(worktreeDir: string): PoolClaim | null {
  for (const repoId of Object.keys(configuredRepos())) {
    for (const c of Object.values(readState(repoId).containers)) {
      if (c.state === "claimed" && c.sessionWorktree === worktreeDir) {
        return { containerName: c.name, hostPort: c.hostPort, repoId };
      }
    }
  }
  return null;
}

export function previewPoolEnabled(repoId: string): boolean {
  return previewPoolConfig(repoId).enabled;
}

/**
 * Claim a warm container for a session worktree. Returns the claim (the
 * caller writes WEBAPP_PORT=<hostPort> into the worktree's .ports.conf and
 * lets the normal status path take over) or null when the pool has nothing
 * ready — the caller falls back to the host boot path.
 */
export async function claimPoolPreview(repoId: string, worktreeDir: string): Promise<PoolClaim | null> {
  const repo = configuredRepos()[repoId];
  if (!repo || !previewPoolEnabled(repoId)) return null;
  const already = poolClaimFor(worktreeDir);
  if (already) return already;

  const state = readState(repoId);
  let pick = Object.values(state.containers).find((c) => c.state === "ready");
  if (!pick) {
    pick = Object.values(state.containers).find((c) => c.state === "paused");
    if (pick && !(await docker(["unpause", pick.name])).ok) pick = undefined;
  }
  if (!pick) {
    // Nothing warm: kick a replenish and let the caller fall back.
    void sweepPool().catch(() => {});
    return null;
  }
  patchContainer(repoId, pick.name, {
    state: "claimed",
    sessionWorktree: worktreeDir,
    claimedAt: new Date().toISOString(),
  });
  await refreshContainerCreds(pick.name);
  // The container may have fetched a newer origin/<default> than the host
  // repo has — make sure bootSha resolves locally before diffing against it.
  if (pick.bootSha) {
    const have = await $`git -C ${worktreeDir} cat-file -e ${pick.bootSha}`.quiet().nothrow();
    if (have.exitCode !== 0) {
      await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.quiet().nothrow();
    }
  }
  try {
    await syncWorktreeIntoContainer(repo, worktreeDir, pick);
  } catch (e) {
    console.warn(`[preview-pool] initial sync into ${pick.name} failed:`, e);
  }
  startSyncLoop(repo, worktreeDir, pick);
  void sweepPool().catch(() => {}); // replenish the pool in the background
  console.log(`[preview-pool] ${repoId}: ${worktreeDir} claimed ${pick.name} (:${pick.hostPort})`);
  return { containerName: pick.name, hostPort: pick.hostPort, repoId };
}

/** Release a worktree's pool preview: stop syncing, destroy the container. */
export async function releasePoolPreview(worktreeDir: string): Promise<boolean> {
  const claim = poolClaimFor(worktreeDir);
  if (!claim) return false;
  stopSyncLoop(worktreeDir);
  await destroyContainer(claim.repoId, claim.containerName);
  void sweepPool().catch(() => {});
  console.log(`[preview-pool] released ${claim.containerName} for ${worktreeDir}`);
  return true;
}

// ── Worktree -> container file sync ──────────────────────────────────────────

/**
 * Changed files between the container's bootSha and the worktree's current
 * content (tracked diffs + untracked non-ignored files). The container tree
 * converges to the worktree's exact content; its own gitignored build state
 * (lib/, .next) is never touched.
 */
async function changedFiles(worktreeDir: string, bootSha: string): Promise<{ copy: string[]; drop: string[] }> {
  const diff = await $`git -C ${worktreeDir} diff --name-status ${bootSha}`.quiet().nothrow().text();
  const untracked = await $`git -C ${worktreeDir} ls-files -o --exclude-standard`.quiet().nothrow().text();
  const copy: string[] = [];
  const drop: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^([A-Z])\S*\t(.+?)(\t(.+))?$/);
    if (!m) continue;
    if (m[1] === "D") drop.push(m[2]);
    else if (m[1] === "R") {
      drop.push(m[2]);
      if (m[4]) copy.push(m[4]);
    } else copy.push(m[2]);
  }
  for (const f of untracked.split("\n")) if (f.trim()) copy.push(f.trim());
  return { copy, drop };
}

async function syncWorktreeIntoContainer(
  repo: Repo,
  worktreeDir: string,
  c: PoolContainer,
  mtimes?: Map<string, number>,
): Promise<void> {
  if (!c.bootSha) return;
  const { copy, drop } = await changedFiles(worktreeDir, c.bootSha);
  const toCopy: string[] = [];
  for (const rel of copy) {
    const abs = join(worktreeDir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const stamp = st.mtimeMs + st.size;
    if (mtimes && mtimes.get(rel) === stamp) continue;
    mtimes?.set(rel, stamp);
    toCopy.push(rel);
  }
  if (drop.length) {
    const rmList = drop.map((p) => JSON.stringify(p)).join(" ");
    await dockerExec(c.name, `cd ${WORKSPACE} && rm -f ${rmList} 2>/dev/null; true`);
    if (mtimes) for (const p of drop) mtimes.delete(p);
  }
  if (!toCopy.length) return;
  // tar stream keeps modes and creates parent dirs in one round trip.
  const tar = Bun.spawn(["tar", "-C", worktreeDir, "-cf", "-", ...toCopy], { stdout: "pipe" });
  const untar = Bun.spawn(["docker", "exec", "-i", c.name, "tar", "-C", WORKSPACE, "-xf", "-"], {
    stdin: tar.stdout,
    stdout: "ignore",
    stderr: "pipe",
  });
  await Promise.all([tar.exited, untar.exited]);
}

function startSyncLoop(repo: Repo, worktreeDir: string, c: PoolContainer): void {
  stopSyncLoop(worktreeDir);
  const mtimes = new Map<string, number>();
  const timer = setInterval(() => {
    void (async () => {
      const claim = poolClaimFor(worktreeDir);
      if (!claim || claim.containerName !== c.name) return stopSyncLoop(worktreeDir);
      if ((await containerRunning(c.name)) !== "running") return stopSyncLoop(worktreeDir);
      await syncWorktreeIntoContainer(repo, worktreeDir, c, mtimes).catch(() => {});
    })();
  }, 2000);
  (timer as { unref?: () => void }).unref?.();
  syncs.set(worktreeDir, { timer, mtimes });
}

function stopSyncLoop(worktreeDir: string): void {
  const s = syncs.get(worktreeDir);
  if (s) clearInterval(s.timer);
  syncs.delete(worktreeDir);
}

/**
 * Re-attach the sync loop after a process restart (claims persist on disk,
 * timers don't). Called from the preview status path — cheap no-op when the
 * loop is already live.
 */
export function resumePoolSyncIfNeeded(worktreeDir: string): void {
  if (syncs.has(worktreeDir)) return;
  const claim = poolClaimFor(worktreeDir);
  if (!claim) return;
  const repo = configuredRepos()[claim.repoId];
  const c = readState(claim.repoId).containers[claim.containerName];
  if (repo && c) startSyncLoop(repo, worktreeDir, c);
}

// ── Scheduler + status ───────────────────────────────────────────────────────

/** Run one reconcile pass now (golden freshness + container top-up). */
export function previewPoolSweepNow(): Promise<void> {
  return sweepPool();
}

async function sweepPool(): Promise<void> {
  const existing = busy.get("sweep");
  if (existing) return existing;
  const run = (async () => {
    for (const repo of Object.values(configuredRepos())) {
      if (repo.sharedCheckout) continue;
      const cfg = previewPoolConfig(repo.id);
      if (!cfg.enabled) {
        // Still reconcile so disabling drains leftovers.
        if (Object.keys(readState(repo.id).containers).length) await ensurePool(repo).catch(() => {});
        continue;
      }
      await refreshGoldenImage(repo.id).catch((e) =>
        console.warn(`[preview-pool] golden refresh ${repo.id} failed:`, e),
      );
      await ensurePool(repo).catch((e) => console.warn(`[preview-pool] ensure ${repo.id} failed:`, e));
      // Keep live warm containers' short-lived creds fresh.
      for (const c of Object.values(readState(repo.id).containers)) {
        if (c.state === "ready") await refreshContainerCreds(c.name).catch(() => {});
      }
    }
  })().finally(() => busy.delete("sweep"));
  busy.set("sweep", run);
  return run;
}

export function ensurePreviewPoolScheduler(): void {
  if (isLocalProfile()) return;
  if (g.__previewPoolTimer) return;
  const t = setInterval(() => {
    sweepPool().catch((e) => console.warn("[preview-pool] sweep failed:", e));
  }, 5 * 60_000);
  (t as { unref?: () => void }).unref?.();
  g.__previewPoolTimer = t;
  // First sweep shortly after boot (not immediately — let the server settle).
  setTimeout(() => void sweepPool().catch(() => {}), 20_000);
}

export interface PreviewPoolStatusEntry {
  repoId: string;
  config: PreviewPoolRepoConfig;
  golden: PoolState["golden"] | null;
  goldenBuilding: boolean;
  containers: PoolContainer[];
}

export function previewPoolStatus(): PreviewPoolStatusEntry[] {
  return Object.values(configuredRepos())
    .filter((r) => !r.sharedCheckout)
    .map((r) => {
      const state = readState(r.id);
      return {
        repoId: r.id,
        config: previewPoolConfig(r.id),
        golden: state.golden ?? null,
        goldenBuilding: busy.has(`golden-${r.id}`),
        containers: Object.values(state.containers),
      };
    });
}

ensurePreviewPoolScheduler();
