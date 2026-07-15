import { $ } from "bun";
import { existsSync } from "fs";
import type { UnifiedSession } from "./types";
import { stopPreview } from "./preview";
import { configuredPaths, configuredRepos, defaultRepo, type Repo } from "./config";

// The Repo type + registry defaults live in config.ts now (the registry is
// config-driven: `repos` in ~/.opensession/config.json merges over the built-in
// Tella map — see docs/portability-audit.md). Re-exported so existing
// `import { type Repo } from "./worktree"` call sites keep working.
export type { Repo } from "./config";

// Root all per-branch worktrees live under. Env-overridable
// (BACKSTAGE_WORKTREES_DIR) → config `paths.worktreesDir` → this VPS's path.
const worktreesDir = () => configuredPaths().worktreesDir;

/**
 * Repos a chat can run against — the merged registry, read fresh from config
 * per access. Kept as a `Record`-shaped Proxy (not a plain snapshot) so the
 * many existing `REPOS[id]` / `Object.values(REPOS)` call sites — including
 * ones this module can't touch — stay correct when config adds or overrides
 * a repo without a restart. New code should prefer `configuredRepos()`.
 */
export const REPOS: Record<string, Repo> = new Proxy({} as Record<string, Repo>, {
  get: (_t, prop) =>
    typeof prop === "string" ? configuredRepos()[prop] : undefined,
  has: (_t, prop) => typeof prop === "string" && prop in configuredRepos(),
  ownKeys: () => Object.keys(configuredRepos()),
  getOwnPropertyDescriptor: (_t, prop) => {
    if (typeof prop !== "string") return undefined;
    const repo = configuredRepos()[prop];
    return repo
      ? { value: repo, enumerable: true, configurable: true, writable: true }
      : undefined;
  },
});

export function getRepo(id?: string): Repo {
  return (id && configuredRepos()[id]) || defaultRepo();
}

/** Infer the repo that owns a checkout/worktree path. */
export function repoForPath(p: string): Repo {
  for (const r of Object.values(configuredRepos())) {
    if (p === r.repo || p.startsWith(`${worktreesDir()}/${r.wtPrefix}-`)) return r;
  }
  return defaultRepo();
}

// Serialize git operations that mutate the shared repo's worktrees. Concurrent
// `git worktree add` race on `.git/config` ("could not lock config file") when two
// runs create worktrees at once — e.g. two loops triggered together, or a loop plus
// a PR action. This in-process mutex runs them one at a time.
let gitOpChain: Promise<unknown> = Promise.resolve();
export function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitOpChain.then(fn, fn);
  gitOpChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
}

/**
 * Seed the webapp's gitignored `.env.local` from the main checkout into a fresh
 * worktree. It carries the WorkOS/AWS config AND the dev-auth bypass
 * (DEV_AUTH_*), so a session can run `just dev` and browser/CDP-test the webapp
 * fully authenticated — no WorkOS login, no per-worktree `vercel env pull`.
 * Best-effort and idempotent: only copies when the source exists and the
 * destination doesn't.
 */
async function seedWebappEnv(webappDir: string): Promise<void> {
  const tellaFusionMain = configuredRepos()["tella-fusion"]?.repo;
  if (!tellaFusionMain) return;
  const src = `${tellaFusionMain}/packages/core/webapp/.env.local`;
  const dest = `${webappDir}/.env.local`;
  try {
    if (existsSync(src) && !existsSync(dest)) {
      await Bun.write(dest, Bun.file(src));
      console.log(`[worktree] seeded .env.local into ${webappDir}`);
    }
  } catch (e) {
    console.warn(`[worktree] failed to seed .env.local into ${webappDir}:`, e);
  }
}

/**
 * Best-effort dependency install in a fresh worktree — sessions can always run
 * `bun install` themselves. Honors the repo's configured `depsInstall` command
 * (run with cwd = the worktree); unset = the historical behavior: tella-fusion
 * installs (and seeds dev-auth env) under packages/core/webapp, other repos
 * install from the repo root when a package.json exists.
 *
 * Interactive create paths fire this WITHOUT awaiting (a tella-fusion webapp
 * `bun install` is ~20-25s — it was the bulk of the "Waiting for workspace"
 * spinner) so the opening turn starts as soon as the git worktree exists; the
 * agent-facing autofix/followup paths still await it because those runs build
 * immediately. All failure paths are caught + logged here, so a dropped
 * promise never surfaces as an unhandled rejection.
 */
/**
 * Fresh-worktree setup: seed build artifacts from the repo's warm preview
 * template when one is enabled + ready (node_modules hardlinks, prebuilt
 * .next/ReScript/WASM output — see warm-template.ts), then the normal dep
 * install (a fast no-op over a seeded tree). Both halves are best-effort;
 * a cold build is always the fallback.
 */
async function seedAndInstallWorktree(
  repo: Repo,
  wtPath: string,
  branchLabel: string,
): Promise<void> {
  try {
    const { seedWorktreeFromWarmTemplate } = await import("./warm-template");
    await seedWorktreeFromWarmTemplate(repo, wtPath);
  } catch (e) {
    console.warn(`[worktree] warm-template seeding failed for ${branchLabel} (continuing):`, e);
  }
  await installWorktreeDeps(repo, wtPath, branchLabel);
}

export async function installWorktreeDeps(repo: Repo, wtPath: string, branchLabel: string): Promise<void> {
  try {
    if (repo.id === "tella-fusion") {
      await seedWebappEnv(`${wtPath}/packages/core/webapp`);
      // .envrc is gitignored (it derives gst.env at direnv time), so fresh
      // worktrees lack it and `direnv exec . just dev` starts with a broken
      // env. Seed it from the main checkout, same as .env.local.
      try {
        if (
          !(await Bun.file(`${wtPath}/.envrc`).exists()) &&
          (await Bun.file(`${repo.repo}/.envrc`).exists())
        ) {
          await Bun.write(`${wtPath}/.envrc`, Bun.file(`${repo.repo}/.envrc`));
        }
      } catch (e) {
        console.warn(`[worktree] .envrc seed failed for ${branchLabel} (continuing):`, e);
      }
      // The static codec crates (x264-static, fdk-aac-static) build from
      // submodule sources; a fresh worktree has those dirs empty, so cargo
      // builds can't validate. Shallow + best-effort.
      try {
        await $`git -C ${wtPath} submodule update --init --depth 1`.quiet();
      } catch (e) {
        console.warn(`[worktree] submodule init failed for ${branchLabel} (continuing):`, e);
      }
    }
    if (repo.depsInstall) {
      await $`sh -c ${repo.depsInstall}`.cwd(wtPath).quiet();
    } else if (repo.id === "tella-fusion") {
      const webappDir = `${wtPath}/packages/core/webapp`;
      if (await Bun.file(`${webappDir}/package.json`).exists()) {
        await $`cd ${webappDir} && bun install`.quiet();
      }
    } else if (await Bun.file(`${wtPath}/package.json`).exists()) {
      await $`cd ${wtPath} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${branchLabel} (continuing):`, e);
  }
}

export async function listWorktrees(repoId?: string): Promise<WorktreeInfo[]> {
  const repo = getRepo(repoId);
  const prefix = `${worktreesDir()}/${repo.wtPrefix}-`;
  try {
    const result = await $`git -C ${repo.repo} worktree list --porcelain`.text();
    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch refs/heads/".length);
      } else if (line === "") {
        if (currentPath && currentBranch && currentPath.startsWith(prefix)) {
          worktrees.push({ branch: currentBranch, path: currentPath });
        }
        currentPath = "";
        currentBranch = "";
      }
    }

    return worktrees;
  } catch (e) {
    console.error("Failed to list worktrees:", e);
    return [];
  }
}

export async function removeWorktree(branch: string, repoId?: string): Promise<void> {
  const repo = getRepo(repoId);
  try {
    const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
    // Stop any running dev server before removing the directory — reads the
    // PGID from .ports/dev-pgid (written by ensure-up.sh) so it works even
    // after a backstage restart or when the server was started by an agent.
    try { await stopPreview(wtPath); } catch {}
    // Use the wt delete script for tella-fusion when available, otherwise plain
    // git worktree remove (the wt script is tella-fusion-specific).
    const wtScript = configuredPaths().wtScript;
    if (repo.id === "tella-fusion" && (await Bun.file(wtScript).exists())) {
      await $`${wtScript} delete ${branch}`.quiet();
    } else {
      await $`git -C ${repo.repo} worktree remove ${wtPath} --force`.quiet();
    }
  } catch (e) {
    console.error(`Failed to remove worktree for ${branch}:`, e);
    // Don't throw — session deletion should still succeed
  }
}

// No uncommitted/untracked changes, and every commit reachable from some
// remote ref (covers both pushed branches and branches merged to origin/main).
// Stale remote refs err on the safe side: recently-pushed work looks unpushed.
async function isWorktreeClean(wtPath: string, branch: string): Promise<boolean> {
  const status = await $`git -C ${wtPath} status --porcelain`.text();
  if (status.trim() !== "") return false;
  const unpushed =
    await $`git -C ${wtPath} rev-list ${branch} --not --remotes --count`.text();
  return unpushed.trim() === "0";
}

// True if the worktree has uncommitted changes or commits beyond its base
// branch — i.e. real work that switching the session's primary repo would
// strand. Errs toward "has work" on any git failure so a switch never silently
// throws work away. Used to gate the clean-only primary-repo switch.
export async function worktreeHasWork(
  wtPath: string,
  branch: string,
  repoId?: string
): Promise<boolean> {
  const repo = getRepo(repoId);
  try {
    const status = await $`git -C ${wtPath} status --porcelain`.text();
    if (status.trim() !== "") return true;
    const ahead =
      await $`git -C ${wtPath} rev-list ${branch} --not origin/${repo.defaultBranch} --count`.text();
    return ahead.trim() !== "" && ahead.trim() !== "0";
  } catch {
    return true;
  }
}

/**
 * Remove worktrees of archived sessions idle for more than `days` days.
 * A worktree survives the sweep if any session sharing its branch is still
 * live (running, unarchived, or recently active), or if it has uncommitted
 * changes or commits that exist on no remote ref — WIP is never deleted.
 * Returns the branches whose worktrees were removed.
 */
export async function sweepArchivedWorktrees(
  sessions: UnifiedSession[],
  days: number
): Promise<string[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const inUse = new Set<string>();
  const candidates = new Set<string>();

  for (const s of sessions) {
    if (!s.branch) continue;
    const sweepable =
      s.archived && !s.isRunning && new Date(s.lastActivity).getTime() < cutoff;
    if (sweepable && s.worktreeDir) candidates.add(s.branch);
    else if (!sweepable) inUse.add(s.branch);
  }

  const existing = new Map(
    (await listWorktrees()).map((w) => [w.branch, w.path])
  );
  const removed: string[] = [];

  for (const branch of candidates) {
    if (inUse.has(branch)) continue;
    const wtPath = existing.get(branch);
    if (!wtPath) continue; // worktree already gone
    try {
      if (!(await isWorktreeClean(wtPath, branch))) continue;
      await removeWorktree(branch);
      if (!existsSync(wtPath)) removed.push(branch);
    } catch (e) {
      console.error(`[worktree-sweep] Skipping ${branch}:`, e);
    }
  }

  return removed;
}

/**
 * Recreate a worktree that was cleaned up while its session lives on. Reuses
 * the local branch when it still exists (uncommitted work is gone, but the
 * branch history survives); otherwise starts the branch fresh from main. The
 * path is identical to the original, so claude session resume keeps working
 * (transcripts are keyed by cwd).
 */
export async function reviveWorktree(branch: string, repoId?: string): Promise<string> {
  const repo = getRepo(repoId);
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  if (existsSync(wtPath)) return wtPath;

  return withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    const hasBranch =
      (await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow()).exitCode === 0;
    if (hasBranch) {
      await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`;
    } else {
      await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`;
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} origin/${repo.defaultBranch}`;
    }
    return wtPath;
  });
}

/**
 * Worktree checked out to an EXISTING PR head branch (not branched from main),
 * so commits/pushes land back on that PR. Uses a dedicated `-michael` path so it
 * never clobbers a human/Slack worktree on the same branch. On reuse, hard-resets
 * to the freshly fetched PR head (each fix iteration pushes before yielding, so
 * there's no un-pushed local work to lose). Push back with
 * `git push origin HEAD:<headRef>`.
 */
export async function createWorktreeForPrBranch(headRef: string): Promise<string> {
  const repo = defaultRepo();
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${headRef}-michael`;

  const reused = await withGitLock(async () => {
    await $`git -C ${repo.repo} fetch origin ${headRef} --quiet`;
    if (existsSync(wtPath)) {
      await $`git -C ${wtPath} fetch origin ${headRef} --quiet`.nothrow();
      await $`git -C ${wtPath} reset --hard origin/${headRef}`.quiet().nothrow();
      return true;
    }
    await $`git -C ${repo.repo} worktree prune`.quiet();
    await $`git -C ${repo.repo} worktree add ${wtPath} -B ${headRef}-michael origin/${headRef}`;
    return false;
  });
  if (reused) return wtPath;

  // Best-effort dep install so checks/builds the agent runs have deps available.
  await seedAndInstallWorktree(repo, wtPath, headRef);

  return wtPath;
}

/**
 * Read-only worktree pinned to a PR's HEAD for review runs. Deliberately
 * separate from the autofix `-michael` worktree: autofix pushes trigger
 * re-reviews, so a review sharing that tree would hard-reset it out from
 * under the still-running autofix. Reviews are ask-mode (Read/Grep only, no
 * builds), so there's no dep install — a bare checkout is enough. On reuse it
 * re-pins to the freshly fetched head, which is safe here because nothing
 * else ever writes in this tree.
 */
export async function createReviewWorktreeForPrHead(headRef: string): Promise<string> {
  const repo = defaultRepo();
  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${headRef}-michael-review`;
  return withGitLock(async () => {
    await $`git -C ${repo.repo} fetch origin ${headRef} --quiet`;
    if (existsSync(wtPath)) {
      await $`git -C ${wtPath} reset --hard origin/${headRef}`.quiet();
      return wtPath;
    }
    await $`git -C ${repo.repo} worktree prune`.quiet();
    await $`git -C ${repo.repo} worktree add ${wtPath} -B ${headRef}-michael-review origin/${headRef}`;
    return wtPath;
  });
}

/**
 * Worktree for a FOLLOW-UP branch cut fresh off `baseRef` (a PR's base, e.g.
 * `main`). Used when someone @-mentions Michael asking for a change on a PR that
 * is already merged/closed — you can't push to the old PR, so the work goes on a
 * new branch that opens its own PR. Idempotent: reuses an existing worktree/branch
 * (so a webhook-redelivery replay doesn't fork a second branch) rather than
 * failing on `worktree add -b`.
 */
export async function createWorktreeForFollowup(
  branch: string,
  baseRef: string,
): Promise<string> {
  const repo = defaultRepo();
  const existing = (await listWorktrees(repo.id)).find((w) => w.branch === branch);
  if (existing) return existing.path;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  await withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    if (existsSync(wtPath)) return; // pruned stale registration; dir already usable
    await $`git -C ${repo.repo} fetch origin ${baseRef} --quiet`.nothrow();
    const startPoint =
      (await $`git -C ${repo.repo} rev-parse --verify --quiet origin/${baseRef}`.nothrow())
        .exitCode === 0
        ? `origin/${baseRef}`
        : `origin/${repo.defaultBranch}`;
    await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`;
  });

  // Best-effort dep install so the follow-up run can build/test, same as siblings.
  await seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Worktree checked out to an EXISTING branch (a PR's head branch), for
 * interactive sessions opened from a PR row. Unlike `createWorktreeForPrBranch`
 * (the autofix agents' variant) it never hard-resets on reuse — a human may
 * have un-pushed work there — and it checks out the branch itself (not a
 * `-michael` copy), so commits/pushes land straight on the PR. Reuses an
 * existing worktree for the branch when one exists; prefers the local branch
 * (it may be ahead of origin), falling back to a fresh tracking branch off
 * `origin/<branch>`. Works for shared-checkout repos too (backstage): a PR
 * branch must never be checked out in the live main checkout, so it always
 * gets an isolated worktree.
 */
export async function createWorktreeForExistingBranch(
  branch: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  const existing = (await listWorktrees(repo.id)).find((w) => w.branch === branch);
  if (existing) return existing.path;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  await withGitLock(async () => {
    await $`git -C ${repo.repo} worktree prune`.quiet();
    if (existsSync(wtPath)) return; // pruned stale registration; dir already usable
    await $`git -C ${repo.repo} fetch origin ${branch} --quiet`.nothrow();
    const hasLocal =
      (await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow())
        .exitCode === 0;
    if (hasLocal) {
      await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`;
    } else {
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} origin/${branch}`;
    }
  });

  // Best-effort seed + dep install, same as createWorktree — backgrounded so
  // the opening turn isn't held behind a ~20s bun install (interactive path).
  void seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Resolve a start-point ref for a new worktree branch: prefer a local ref
 * matching `base`, then `origin/<base>`, then `origin/<defaultBranch>`. Used for
 * stacked worktrees that branch off a workspace's existing branch.
 */
async function resolveStartPoint(
  repoDir: string,
  base: string,
  defaultBranch: string,
): Promise<string> {
  if ((await $`git -C ${repoDir} rev-parse --verify --quiet ${base}`.nothrow()).exitCode === 0)
    return base;
  if (
    (await $`git -C ${repoDir} rev-parse --verify --quiet origin/${base}`.nothrow()).exitCode === 0
  )
    return `origin/${base}`;
  return `origin/${defaultBranch}`;
}

/**
 * The path `createWorktree(branch, repoId)` will produce, without doing any
 * git work. Lets the create-session flow announce a session (and drop the UI
 * into its empty chat) before the slow worktree setup actually runs.
 * `isolated` forces the per-branch worktree path even for shared-checkout
 * repos — the from-PR flow checks out PR branches in isolation, never the
 * live main checkout (matches `createWorktreeForExistingBranch`).
 */
export function worktreePathFor(
  branch: string,
  repoId?: string,
  opts?: { isolated?: boolean },
): string {
  const repo = getRepo(repoId);
  return repo.sharedCheckout && !opts?.isolated
    ? repo.repo
    : `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
}

/**
 * Pick a branch name that `git worktree add -b` can actually create, starting
 * from `desired` and bumping (`name`, `name-2`, `name-3`, …) until it clears
 * every existing local branch. Three collision kinds all block creation, and
 * we guard all three because git stores refs as files under `refs/heads/`:
 *   - exact match (`test` when `test` exists),
 *   - `desired` is a directory of an existing ref (`test` when `test/foo`
 *     exists — the reported failure: "cannot lock ref … 'test/…' exists"),
 *   - an existing ref is a directory prefix of `desired` (`test/foo` when a
 *     branch `test` exists).
 * Callers pass slug names (sanitizeBranchSlug maps `/`→`-`), and a suffix bump
 * always clears the first two collisions for a slash-free name; the third only
 * arises for slashed names (not produced here), where a parent branch blocks
 * the whole subtree and no suffix escapes it — we then return `desired` and let
 * the worktree add fail loudly rather than loop.
 * Used by the new-session path so a fresh session never dies on a name clash.
 * Reuse paths (existing worktree for the branch, from-PR, orphan adoption in
 * `createWorktree`) intentionally do NOT go through here — they want the exact
 * name back.
 */
export async function resolveUniqueBranch(
  desired: string,
  repoId?: string,
): Promise<string> {
  const repo = getRepo(repoId);
  // The format literal is interpolated (not written into the template) so Bun's
  // shell parser doesn't choke on the `%(…)` parens.
  const fmt = "%(refname:short)";
  const existing = new Set(
    (
      await $`git -C ${repo.repo} for-each-ref --format=${fmt} refs/heads`
        .nothrow()
        .text()
    )
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean),
  );
  const collides = (name: string) =>
    [...existing].some(
      (b) => b === name || b.startsWith(`${name}/`) || name.startsWith(`${b}/`),
    );
  if (!collides(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${desired}-${n}`;
    if (!collides(candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to the desired name and let the worktree
  // add fail loudly rather than loop forever.
  return desired;
}

/**
 * Create a worktree for `branch`. By default it branches from
 * `origin/<defaultBranch>`. Pass `opts.base` (e.g. a workspace's branch) to
 * create a *stacked* worktree branched off that ref instead — this is what lets
 * chats in a workspace stack PRs on top of the workspace's branch.
 */
export async function createWorktree(
  branch: string,
  repoId?: string,
  opts?: { base?: string; isolated?: boolean },
): Promise<string> {
  const repo = getRepo(repoId);

  // Shared-checkout repos (backstage) don't get a per-session worktree: the
  // session works in the live main checkout on the default branch so its edits
  // hot-reload in the running server. No branch is created or switched — every
  // session stays on the default branch and commits there.
  // `isolated` opts out and builds a real per-branch worktree even for a
  // shared-checkout repo — unattended code runs (automations) must never work
  // in the live checkout; they ship a PR instead (matches worktreePathFor /
  // createWorktreeForExistingBranch).
  if (repo.sharedCheckout && !opts?.isolated) return repo.repo;

  const wtPath = `${worktreesDir()}/${repo.wtPrefix}-${branch}`;
  const base = opts?.base;

  await withGitLock(async () => {
    await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
    let startPoint = `origin/${repo.defaultBranch}`;
    if (base) {
      // Stacked worktree: fetch the base (it may be remote-only), then branch off it.
      await $`git -C ${repo.repo} fetch origin ${base} --quiet`.nothrow();
      startPoint = await resolveStartPoint(repo.repo, base, repo.defaultBranch);
    }
    const add =
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`
        .quiet()
        .nothrow();
    if (add.exitCode === 0) return;
    // Collision tolerance: a create attempt killed mid-flight (e.g. a restart
    // drain) can leave the BRANCH created but no worktree — the retry then
    // died on "a branch named '…' already exists". Adopt such an orphan
    // branch only when it is provably just a base marker: zero commits of its
    // own on top of the start point and no registered worktree. A branch with
    // unique commits is somebody's work — keep failing loudly, never silently
    // adopt it.
    const stderr = add.stderr.toString();
    const branchExists =
      (await $`git -C ${repo.repo} show-ref --verify --quiet refs/heads/${branch}`.nothrow())
        .exitCode === 0;
    if (branchExists) {
      const ahead = (
        await $`git -C ${repo.repo} rev-list --count ${startPoint}..${branch}`.nothrow()
      ).stdout
        .toString()
        .trim();
      await $`git -C ${repo.repo} worktree prune`.quiet().nothrow();
      const registered = (await listWorktrees(repo.id)).some((w) => w.branch === branch);
      if (ahead === "0" && !registered && !existsSync(wtPath)) {
        console.warn(
          `[worktree] adopting orphan branch ${branch} (0 commits ahead of ${startPoint}, no worktree) — likely a killed create attempt`,
        );
        await $`git -C ${repo.repo} worktree add ${wtPath} ${branch}`;
        return;
      }
    }
    throw new Error(
      `git worktree add -b ${branch} failed: ${stderr.trim().slice(0, 300)}`,
    );
  });

  // Best-effort warm-template seed + dep install — sessions can always run
  // `bun install` themselves. tella-fusion's deps + dev-auth env live under
  // the webapp; other repos (e.g. backstage) install from the repo root.
  // Config `depsInstall` overrides. Backgrounded (not awaited): the opening
  // turn shouldn't wait ~20s on a webapp bun install it usually doesn't need.
  void seedAndInstallWorktree(repo, wtPath, branch);

  return wtPath;
}

/**
 * Resolve an isolated worktree for attaching a secondary repo to a session,
 * reusing an existing worktree for the branch when one is already checked out.
 * Returns the repo id, branch, and worktree dir. Shared-checkout repos
 * (backstage) can't be attached as an isolated worktree — they'd hand back the
 * live main checkout, so reject them.
 */
export async function prepareAttachedWorktree(
  repoId: string,
  branch: string
): Promise<{ repo: string; branch: string; dir: string }> {
  const repo = getRepo(repoId);
  if (repo.sharedCheckout) {
    throw new Error(`${repo.id} is a shared-checkout repo and can't be attached as an isolated worktree`);
  }
  const existing = (await listWorktrees(repo.id)).find((w) => w.branch === branch);
  const dir = existing?.path || (await createWorktree(branch, repo.id));
  return { repo: repo.id, branch, dir };
}
