/**
 * Warm preview templates — per-repo prebuilt worktrees kept fresh from the
 * default branch on a schedule, so a new session's dev server starts warm
 * instead of paying bun install + ReScript's ~2.6k-module initial build +
 * Turbopack's cold first-page compile (minutes) in every fresh worktree.
 *
 * How it works:
 *  - Each enabled repo gets ONE template worktree at
 *    `<worktreesDir>/<wtPrefix>-warm-template`, checked out DETACHED at
 *    `origin/<defaultBranch>`. Detached is deliberate: listWorktrees() only
 *    surfaces worktrees with a branch line, so the template can never be
 *    adopted by workspaces/sessions, and there's no branch to accidentally
 *    push. repoForPath() still resolves it (prefix match) so the normal
 *    preview machinery works inside it.
 *  - A refresh (scheduled every `intervalHours`, or via the Settings
 *    "Refresh now" button) fetches + `reset --hard origin/<defaultBranch>`
 *    (tracked files only — build artifacts survive, so rebuilds are
 *    incremental), installs deps, then REALLY boots the dev server via the
 *    shared preview chain (startPreview → resolvePreviewBoot), curls the
 *    warm routes so the on-demand compiler fills its caches, and stops it.
 *    Booting for real is the verification: a template that can't serve a
 *    page is never marked ok.
 *  - On success it captures a MANIFEST of the template's gitignored build
 *    artifacts (`git ls-files -o -i --exclude-standard --directory`) minus
 *    runtime junk (ports/tunnels/logs/env). Fresh worktrees are seeded from
 *    that manifest right after `git worktree add`: node_modules trees are
 *    HARDLINKED (`cp -al` — package managers replace files, never edit them
 *    in place, so links are safe and ~free), everything else (.next,
 *    ReScript lib/ + in-source *.res.mjs, WASM bindings) is really copied —
 *    compilers may rewrite those in place, and a shared inode would corrupt
 *    the template and every sibling session.
 *
 * Config (Settings → Warm previews): `<chats>/warm-templates/config.json`
 *   { "repos": { "tella-fusion": { "enabled": true, "intervalHours": 6 } } }
 * State per repo: `<chats>/warm-templates/<repoId>.state.json` (+ the
 * manifest at `<repoId>.manifest`, only rewritten on a SUCCESSFUL refresh so
 * a failed refresh keeps seeding from the last good one).
 *
 * Everything here is host-side (covers host previews AND docker bind-mode
 * sandboxes, whose workspaces are these same worktrees). The remote-sandbox
 * warm path (pre-cloning the repo inside a daytona prewarm) lives in
 * sandbox/adapters/bootstrap.ts and reads the same config.
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { configuredPaths, configuredRepos, type Repo } from "./config";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

// ── Config ───────────────────────────────────────────────────────────────────

export interface WarmTemplateRepoConfig {
  enabled: boolean;
  /** Refresh cadence in hours (default 6). */
  intervalHours: number;
  /** Routes curled after boot to fill the on-demand compiler caches. */
  warmRoutes: string[];
}

export const WARM_DEFAULTS: Omit<WarmTemplateRepoConfig, "enabled"> = {
  intervalHours: 6,
  warmRoutes: ["/", "/api/session"],
};

function warmDir(): string {
  return join(OPENSESSION_CHATS_DIR, "warm-templates");
}

function configFile(): string {
  return join(warmDir(), "config.json");
}

/** Per-repo warm config, read fresh per call (Settings PUTs rewrite it).
 *  warmRoutes precedence: explicit instance config → the repo's committed
 *  `.opensession/preview.json` (read from the template worktree, so the repo
 *  itself declares which routes to pre-compile) → defaults. */
export function warmTemplateConfig(repoId: string): WarmTemplateRepoConfig {
  const raw = readWarmConfigRaw()[repoId];
  const explicitRoutes =
    Array.isArray(raw?.warmRoutes) && raw.warmRoutes.length
      ? raw.warmRoutes.filter((r: unknown): r is string => typeof r === "string")
      : null;
  return {
    enabled: raw?.enabled === true,
    intervalHours:
      typeof raw?.intervalHours === "number" && raw.intervalHours >= 1
        ? Math.floor(raw.intervalHours)
        : WARM_DEFAULTS.intervalHours,
    warmRoutes: explicitRoutes || repoWarmRoutes(repoId) || WARM_DEFAULTS.warmRoutes,
  };
}

/** `warmRoutes` from the repo's committed `.opensession/preview.json`
 *  (`.backstage/` honored as the pre-rename fallback), read out of the
 *  template worktree when it exists. Null = the repo doesn't declare any. */
function repoWarmRoutes(repoId: string): string[] | null {
  const repo = configuredRepos()[repoId];
  if (!repo) return null;
  for (const lifecycleDir of [".opensession", ".backstage"]) {
    try {
      const f = join(warmTemplateDir(repo), lifecycleDir, "preview.json");
      if (!existsSync(f)) continue;
      const routes = JSON.parse(readFileSync(f, "utf-8"))?.warmRoutes;
      if (Array.isArray(routes)) {
        const out = routes.filter((r: unknown): r is string => typeof r === "string");
        if (out.length) return out;
      }
    } catch {}
  }
  return null;
}

function readWarmConfigRaw(): Record<string, any> {
  try {
    const f = configFile();
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return parsed?.repos && typeof parsed.repos === "object" ? parsed.repos : {};
  } catch {
    return {};
  }
}

export function setWarmTemplateConfig(
  repoId: string,
  patch: Partial<Pick<WarmTemplateRepoConfig, "enabled" | "intervalHours" | "warmRoutes">>,
): WarmTemplateRepoConfig {
  mkdirSync(warmDir(), { recursive: true });
  const repos = readWarmConfigRaw();
  repos[repoId] = { ...repos[repoId], ...patch };
  writeJsonAtomic(configFile(), { repos });
  const cfg = warmTemplateConfig(repoId);
  // Turning a repo on shouldn't wait for the next sweep tick.
  if (patch.enabled) void refreshWarmTemplate(repoId).catch(() => {});
  return cfg;
}

// ── State ────────────────────────────────────────────────────────────────────

export interface WarmTemplateState {
  repoId: string;
  dir: string;
  /** origin/<defaultBranch> sha the template was last built at. */
  sha?: string;
  refreshedAt?: string;
  /** Last refresh wall time (ms). */
  lastDurationMs?: number;
  /** Whether the last refresh completed (boot verified + manifest captured). */
  ok?: boolean;
  lastError?: string;
  /** Artifact entries in the manifest (informational, for the UI). */
  manifestEntries?: number;
}

function stateFile(repoId: string): string {
  return join(warmDir(), `${repoId}.state.json`);
}

function manifestFile(repoId: string): string {
  return join(warmDir(), `${repoId}.manifest`);
}

export function warmTemplateState(repoId: string): WarmTemplateState | null {
  try {
    const f = stateFile(repoId);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf-8")) as WarmTemplateState;
  } catch {
    return null;
  }
}

function writeState(state: WarmTemplateState): void {
  try {
    mkdirSync(warmDir(), { recursive: true });
    writeJsonAtomic(stateFile(state.repoId), state);
  } catch (e) {
    console.warn(`[warm-template] persist(${state.repoId}) failed:`, e);
  }
}

/** The template worktree path for a repo (whether or not it exists yet). */
export function warmTemplateDir(repo: Repo): string {
  return `${configuredPaths().worktreesDir}/${repo.wtPrefix}-warm-template`;
}

// In-flight refreshes (repoId → completion promise), parked on globalThis so
// --hot reloads can't double-refresh a repo.
const g = globalThis as unknown as {
  __warmTemplateRefreshing?: Map<string, Promise<void>>;
  __warmTemplateSeeding?: Set<string>;
  __warmTemplateSweepTimer?: ReturnType<typeof setInterval>;
};
const refreshing: Map<string, Promise<void>> = (g.__warmTemplateRefreshing ??= new Map());
// Worktrees with a seed in flight (one seed per worktree — see seedWorktree…).
const seeding: Set<string> = (g.__warmTemplateSeeding ??= new Set());

// Cross-PROCESS refresh marker: the in-memory `refreshing` map can't be seen
// by other processes (a CLI-triggered refresh vs the live server's seeds —
// exactly the race that fed a mid-reset template into a session seed on
// 2026-07-09). doRefresh holds this file; seeds wait for / bail on it.
function refreshLockFile(repoId: string): string {
  return join(warmDir(), `${repoId}.refresh.lock`);
}

function refreshLockHeld(repoId: string): boolean {
  try {
    const f = refreshLockFile(repoId);
    if (!existsSync(f)) return false;
    // A crashed refresh must not wedge seeding forever — stale locks expire.
    return Date.now() - statSync(f).mtimeMs < 20 * 60_000;
  } catch {
    return false;
  }
}

export function warmTemplateRefreshing(repoId: string): boolean {
  return refreshing.has(repoId);
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/** Runtime junk that must never be seeded into a fresh worktree: per-worktree
 *  port allocations, preview tunnels contract, logs, env files (seedWebappEnv
 *  owns .env.local), and editor/tool droppings. */
const MANIFEST_EXCLUDES: RegExp[] = [
  /^\.ports(\.conf|\/)/,
  /^\.tunnels\.env$/,
  /(^|\/)[^/]*\.log$/,
  /(^|\/)\.env(\..+)?$/,
  /^\.direnv\//,
  /(^|\/)\.DS_Store$/,
];

/** Filter raw `git ls-files -o -i --directory` output into seedable entries.
 *  Exported for tests. */
export function filterManifest(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !MANIFEST_EXCLUDES.some((re) => re.test(l)));
}

/** True when a manifest entry is a node_modules tree — safe (and important,
 *  it's multi-GB) to hardlink rather than copy. Exported for tests. */
export function isNodeModulesEntry(entry: string): boolean {
  return /(^|\/)node_modules\/$/.test(entry);
}

// ── Refresh ──────────────────────────────────────────────────────────────────

const BOOT_TIMEOUT_MS = 12 * 60_000;
const ROUTE_WARM_TIMEOUT_MS = 240_000;
/** Post-warm write-quiescence: how long the tree must go without artifact
 *  writes before the server is stopped, and the cap on waiting for that. */
const QUIET_WINDOW_S = 25;
const QUIET_TIMEOUT_MS = 10 * 60_000;

/**
 * Refresh a repo's warm template (idempotent; concurrent calls share one
 * run). `force` rebuilds even when origin's sha hasn't moved — the scheduled
 * sweep passes false so an unchanged main is a cheap fetch + no-op.
 */
export function refreshWarmTemplate(repoId: string, opts?: { force?: boolean }): Promise<void> {
  const inflight = refreshing.get(repoId);
  if (inflight) return inflight;
  const run = doRefresh(repoId, opts?.force === true).finally(() => {
    if (refreshing.get(repoId) === run) refreshing.delete(repoId);
  });
  refreshing.set(repoId, run);
  return run;
}

async function doRefresh(repoId: string, force: boolean): Promise<void> {
  const repo = configuredRepos()[repoId];
  if (!repo) return;
  if (repo.sharedCheckout) return; // backstage self-hosts; nothing to warm
  const cfg = warmTemplateConfig(repoId);
  if (!cfg.enabled && !force) return;
  const dir = warmTemplateDir(repo);
  const started = Date.now();
  const prev = warmTemplateState(repoId);
  const fail = async (msg: string) => {
    console.warn(`[warm-template] ${repoId}: ${msg}`);
    writeState({
      ...(prev || {}),
      repoId,
      dir,
      ok: false,
      lastError: msg.slice(0, 500),
      lastDurationMs: Date.now() - started,
    });
  };

  try {
    mkdirSync(warmDir(), { recursive: true });
    writeFileSync(refreshLockFile(repoId), `${process.pid} ${new Date().toISOString()}\n`);
    // Lazy imports: worktree.ts/preview.ts import back into this module's
    // consumers — keep the static graph acyclic.
    const { withGitLock, installWorktreeDeps } = await import("./worktree");
    const { startPreview, getPreviewStatus, stopPreview } = await import("./preview");

    // 1. Ensure the detached template worktree exists.
    if (!existsSync(dir)) {
      console.log(`[warm-template] ${repoId}: creating template worktree at ${dir}`);
      await withGitLock(async () => {
        await $`git -C ${repo.repo} worktree prune`.quiet().nothrow();
        if (existsSync(dir)) return;
        await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
        await $`git -C ${repo.repo} worktree add --detach ${dir} origin/${repo.defaultBranch}`;
      });
    }

    // 2. Fetch; skip the expensive rebuild when nothing moved and the last
    //    refresh was good.
    await $`git -C ${dir} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
    const sha = (
      await $`git -C ${dir} rev-parse --short origin/${repo.defaultBranch}`.nothrow().text()
    ).trim();
    if (!sha) return void (await fail(`can't resolve origin/${repo.defaultBranch}`));
    if (!force && prev?.ok && prev.sha === sha && existsSync(manifestFile(repoId))) {
      return; // already warm at this sha
    }
    console.log(`[warm-template] ${repoId}: refreshing template to ${sha} (${dir})`);

    // 3. Advance the tree. reset --hard touches TRACKED files only — the
    //    whole point is that gitignored build artifacts survive, so the
    //    rebuild below is incremental. This is our dedicated detached
    //    worktree; the shared-checkout no-reset rule doesn't apply here.
    await $`git -C ${dir} reset --hard origin/${repo.defaultBranch}`.quiet();

    // 4. Deps + env seeding (same helper the session worktrees use).
    await installWorktreeDeps(repo, dir, `warm-template:${repoId}`);

    // 5. Boot the dev server for real via the shared preview chain. This is
    //    both the cache-warmer (ReScript initial build, Turbopack route
    //    compiles) and the verification that the template actually works.
    let status = await startPreview(dir);
    if (!status.bootable) {
      return void (await fail("repo has no preview boot mechanism (start.sh/previewCommand)"));
    }
    const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!status.running && Date.now() < bootDeadline) {
      await Bun.sleep(5000);
      status = await getPreviewStatus(dir);
      if (!status.starting && !status.running) break; // bring-up process died
    }
    if (!status.running || !status.webappPort) {
      await stopPreview(dir).catch(() => {});
      return void (await fail("dev server did not come up during refresh"));
    }

    // 6. Warm the configured routes — the request itself triggers the
    //    on-demand compile; any HTTP response means the route is built.
    for (const route of cfg.warmRoutes) {
      const path = route.startsWith("/") ? route : `/${route}`;
      const deadline = Date.now() + ROUTE_WARM_TIMEOUT_MS;
      let warmed = false;
      // localhost, NOT 127.0.0.1: tella-fusion's middleware routes by Host
      // header (custom-domain catch-all), and a bare IP host falls into the
      // [domain] handler → HTML 404 — the route never compiles. localhost is
      // the first-party host dev servers treat as their own.
      while (!warmed && Date.now() < deadline) {
        try {
          const res = await fetch(`http://localhost:${status.webappPort}${path}`, {
            signal: AbortSignal.timeout(ROUTE_WARM_TIMEOUT_MS),
            redirect: "manual",
          });
          await res.arrayBuffer().catch(() => {});
          warmed = true;
        } catch {
          await Bun.sleep(3000);
        }
      }
      console.log(`[warm-template] ${repoId}: route ${path} ${warmed ? "warmed" : "TIMED OUT"}`);
    }

    // 6b. The dev boot kicks off background compilers (ReScript's ~2.6k-module
    //    initial build, Turbopack route compiles) that keep writing artifacts
    //    well after the port is listening — stopping as soon as routes answer
    //    captured a PARTIAL template on the first live refresh (the compiled
    //    API__Session.bs.js was missing, so seeded worktrees 404'd on
    //    /api/session). Wait until the tree has been write-quiet for a full
    //    window before stopping; bounded, and noisy runtime paths (logs,
    //    .next/trace) don't count as build activity.
    const quietDeadline = Date.now() + QUIET_TIMEOUT_MS;
    while (Date.now() < quietDeadline) {
      const recent = await $`find ${dir} \( -path ${`${dir}/.git`} -o -path ${`${dir}/.ports`} -o -name "*.log" -o -path "*/.next/trace*" \) -prune -o -type f -newermt ${`${QUIET_WINDOW_S} seconds ago`} -print -quit`
        .quiet()
        .nothrow()
        .text();
      if (!recent.trim()) break;
      await Bun.sleep(5000);
    }

    // 7. Done with the server — the template only needs the artifacts.
    await stopPreview(dir).catch(() => {});

    // 8. Capture the artifact manifest (only on success, so a failed refresh
    //    keeps seeding from the last good state).
    const raw = await $`git -C ${dir} ls-files -o -i --exclude-standard --directory`.text();
    const manifest = filterManifest(raw.split("\n"));
    if (!manifest.length) return void (await fail("refresh produced no build artifacts"));
    writeFileSync(manifestFile(repoId), manifest.join("\n") + "\n");

    writeState({
      repoId,
      dir,
      sha,
      refreshedAt: new Date().toISOString(),
      lastDurationMs: Date.now() - started,
      ok: true,
      manifestEntries: manifest.length,
    });
    console.log(
      `[warm-template] ${repoId}: template warm at ${sha} — ${manifest.length} artifact entries, ${Math.round((Date.now() - started) / 1000)}s`,
    );
  } catch (e) {
    await fail(String((e as any)?.message || e));
  } finally {
    try {
      unlinkSync(refreshLockFile(repoId));
    } catch {}
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Copy the warm template's build artifacts into a fresh worktree. Called
 * right after `git worktree add`, before the normal dep install (which then
 * becomes a fast no-op). Best-effort: any failure logs and the worktree just
 * builds cold like today. Returns true when seeding actually ran.
 */
export async function seedWorktreeFromWarmTemplate(repo: Repo, wtPath: string): Promise<boolean> {
  try {
    const cfg = warmTemplateConfig(repo.id);
    if (!cfg.enabled) return false;
    const state = warmTemplateState(repo.id);
    const mf = manifestFile(repo.id);
    if (!state?.ok || !existsSync(mf) || !existsSync(state.dir)) return false;
    if (wtPath === state.dir) return false; // never seed the template itself

    // A refresh mid-flight is rewriting artifacts under us. In-process we can
    // await it; a refresh in ANOTHER process is visible only via the lock
    // file — wait briefly, then bail to a cold build rather than copy from a
    // tree being reset (that race aborted a seed live on 2026-07-09).
    const inflight = refreshing.get(repo.id);
    if (inflight) {
      await Promise.race([inflight, Bun.sleep(60_000)]);
    }
    for (let waited = 0; refreshLockHeld(repo.id) && waited < 90_000; waited += 5000) {
      await Bun.sleep(5000);
    }
    if (refreshLockHeld(repo.id)) {
      console.log(
        `[warm-template] ${repo.id} template is mid-refresh (another process) — ${wtPath} builds cold`,
      );
      return false;
    }

    // One seed per worktree at a time: duplicate create paths racing two
    // cp -al's into the same node_modules produced "cannot create directory:
    // File exists" and killed the whole seed (bks-019f48d6, 2026-07-09).
    if (seeding.has(wtPath)) return false;
    seeding.add(wtPath);
    try {
      const started = Date.now();
      const entries = filterManifest(readFileSync(mf, "utf-8").split("\n"));
      const linkDirs = entries.filter(isNodeModulesEntry);
      const copyEntries = entries.filter((e) => !isNodeModulesEntry(e));

      // node_modules trees: hardlink farms (~free for multi-GB trees; package
      // managers replace files rather than editing in place, so shared inodes
      // are safe). Per-entry best-effort: a conflict with a concurrent writer
      // (e.g. an already-running bun install) must not abort the other
      // entries or the copy stage below — bun install reconciles whatever
      // landed.
      for (const entry of linkDirs) {
        const src = join(state.dir, entry).replace(/\/$/, "");
        const dst = join(wtPath, entry).replace(/\/$/, "");
        if (!existsSync(src) || existsSync(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        const r = await $`cp -al ${src} ${dst}`.quiet().nothrow();
        if (r.exitCode !== 0) {
          console.warn(
            `[warm-template] hardlink of ${entry} into ${wtPath} was partial (exit ${r.exitCode}) — bun install will reconcile`,
          );
        }
      }

      // Everything else (.next, ReScript lib/ + in-source *.res.mjs, WASM
      // bindings): real copies in ONE rsync pass — compilers may rewrite
      // these in place, and hardlinks would cross-corrupt sessions +
      // template. --ignore-existing keeps concurrent writers safe.
      if (copyEntries.length) {
        const listFile = join(warmDir(), `.seed-${process.pid}-${Date.now()}.list`);
        writeFileSync(listFile, copyEntries.join("\n") + "\n");
        try {
          const r =
            await $`rsync -a -r --ignore-existing --files-from=${listFile} ${state.dir}/ ${wtPath}/`
              .quiet()
              .nothrow();
          if (r.exitCode !== 0) {
            console.warn(
              `[warm-template] artifact copy into ${wtPath} was partial (rsync exit ${r.exitCode})`,
            );
          }
        } finally {
          try {
            unlinkSync(listFile);
          } catch {}
        }
      }

      console.log(
        `[warm-template] seeded ${wtPath} from ${repo.id} template (${state.sha}) in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      return true;
    } finally {
      seeding.delete(wtPath);
    }
  } catch (e) {
    console.warn(`[warm-template] seeding ${wtPath} failed (worktree builds cold):`, e);
    return false;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60_000;

async function sweepWarmTemplates(): Promise<void> {
  for (const repo of Object.values(configuredRepos())) {
    if (repo.sharedCheckout) continue;
    const cfg = warmTemplateConfig(repo.id);
    if (!cfg.enabled) continue;
    const state = warmTemplateState(repo.id);
    const ageMs = state?.refreshedAt ? Date.now() - Date.parse(state.refreshedAt) : Infinity;
    const due = !state?.ok || ageMs > cfg.intervalHours * 3_600_000;
    if (!due) continue;
    // Serialized: one template rebuild at a time — a rebuild is a real dev
    // server boot and shouldn't stack across repos.
    await refreshWarmTemplate(repo.id).catch((e) =>
      console.warn(`[warm-template] scheduled refresh of ${repo.id} failed:`, e),
    );
  }
}

/** Arm the sweep once per process (globalThis-parked, unref'd — never keeps
 *  a test/CLI process alive). Cheap no-op every tick while nothing is
 *  enabled, so it's armed unconditionally at module load. */
export function ensureWarmTemplateScheduler(): void {
  if (g.__warmTemplateSweepTimer) return;
  const t = setInterval(() => {
    sweepWarmTemplates().catch((e) => console.warn("[warm-template] sweep failed:", e));
  }, SWEEP_INTERVAL_MS);
  (t as { unref?: () => void }).unref?.();
  g.__warmTemplateSweepTimer = t;
}

ensureWarmTemplateScheduler();

// ── Status (Settings API) ────────────────────────────────────────────────────

export interface WarmTemplateStatusEntry {
  repoId: string;
  enabled: boolean;
  intervalHours: number;
  refreshing: boolean;
  state: WarmTemplateState | null;
}

export function warmTemplateStatus(): WarmTemplateStatusEntry[] {
  return Object.values(configuredRepos())
    .filter((r) => !r.sharedCheckout)
    .map((r) => {
      const cfg = warmTemplateConfig(r.id);
      return {
        repoId: r.id,
        enabled: cfg.enabled,
        intervalHours: cfg.intervalHours,
        refreshing: warmTemplateRefreshing(r.id),
        state: warmTemplateState(r.id),
      };
    });
}
