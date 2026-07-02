import { $ } from "bun";
import { existsSync } from "fs";
import type { UnifiedSession } from "./types";

const TELLA_FUSION = "/home/ubuntu/projects/tella-fusion";
const WORKTREES_DIR = "/home/ubuntu/worktrees";

// Repos a chat can run against. Worktrees live at
// <WORKTREES_DIR>/<wtPrefix>-<branch>; defaultBranch is the base they branch
// from. tella-fusion is the default for every existing caller.
//
// NOTE: this is the *repo* concept. A "Project" in the UI is a separate thing —
// an optional folder that groups chats (see src/server/projects.ts). A chat's
// worktree lives on the chat and belongs to one of these repos.
export interface Repo {
  id: string;
  repo: string;
  wtPrefix: string;
  defaultBranch: string;
  /** GitHub `owner/name` for PR operations (gh CLI). */
  ghRepo: string;
  // When true, code sessions run directly in the main checkout on the default
  // branch instead of an isolated worktree. Backstage is self-hosting — the live
  // server runs `bun --hot` from its main checkout, so editing there is the only
  // way a change is testable without a second instance. Sessions share one tree
  // and commit straight to the default branch (see "Backstage dev workflow" in
  // CLAUDE.md: add → commit → push, never reset/discard the shared repo).
  sharedCheckout?: boolean;
}

export const REPOS: Record<string, Repo> = {
  "tella-fusion": { id: "tella-fusion", repo: TELLA_FUSION, wtPrefix: "tella-fusion", defaultBranch: "main", ghRepo: "tellahq/tella-fusion" },
  backstage: { id: "backstage", repo: "/home/ubuntu/projects/tella-backstage", wtPrefix: "backstage", defaultBranch: "master", ghRepo: "tellahq/backstage", sharedCheckout: true },
  // Infra / GitOps / media repos — normal worktree + PR flow (none self-host).
  gitops: { id: "gitops", repo: "/home/ubuntu/projects/gitops", wtPrefix: "gitops", defaultBranch: "main", ghRepo: "tellahq/gitops" },
  infra: { id: "infra", repo: "/home/ubuntu/projects/infra", wtPrefix: "infra", defaultBranch: "main", ghRepo: "tellahq/infra" },
  "shared-infra": { id: "shared-infra", repo: "/home/ubuntu/projects/shared-infra", wtPrefix: "shared-infra", defaultBranch: "main", ghRepo: "tellahq/shared-infra" },
  gstreamer: { id: "gstreamer", repo: "/home/ubuntu/projects/gstreamer", wtPrefix: "gstreamer", defaultBranch: "tla_main", ghRepo: "tellahq/gstreamer" },
  "gst-plugins-rs": { id: "gst-plugins-rs", repo: "/home/ubuntu/projects/gst-plugins-rs", wtPrefix: "gst-plugins-rs", defaultBranch: "tla_main", ghRepo: "tellahq/gst-plugins-rs" },
};

export function getRepo(id?: string): Repo {
  return (id && REPOS[id]) || REPOS["tella-fusion"];
}

/** Infer the repo that owns a checkout/worktree path. */
export function repoForPath(p: string): Repo {
  for (const r of Object.values(REPOS)) {
    if (p === r.repo || p.startsWith(`${WORKTREES_DIR}/${r.wtPrefix}-`)) return r;
  }
  return REPOS["tella-fusion"];
}

// Serialize git operations that mutate the shared repo's worktrees. Concurrent
// `git worktree add` race on `.git/config` ("could not lock config file") when two
// runs create worktrees at once — e.g. two loops triggered together, or a loop plus
// a PR action. This in-process mutex runs them one at a time.
let gitOpChain: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
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
  const src = `${TELLA_FUSION}/packages/core/webapp/.env.local`;
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

export async function listWorktrees(repoId?: string): Promise<WorktreeInfo[]> {
  const repo = getRepo(repoId);
  const prefix = `${WORKTREES_DIR}/${repo.wtPrefix}-`;
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
    const wtPath = `${WORKTREES_DIR}/${repo.wtPrefix}-${branch}`;
    // Use the wt delete script for tella-fusion when available, otherwise plain
    // git worktree remove (the wt script is tella-fusion-specific).
    if (repo.id === "tella-fusion" && (await Bun.file("/home/ubuntu/bin/wt").exists())) {
      await $`/home/ubuntu/bin/wt delete ${branch}`.quiet();
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
  const wtPath = `${WORKTREES_DIR}/${repo.wtPrefix}-${branch}`;
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
  const wtPath = `${WORKTREES_DIR}/tella-fusion-${headRef}-michael`;

  const reused = await withGitLock(async () => {
    await $`git -C ${TELLA_FUSION} fetch origin ${headRef} --quiet`;
    if (existsSync(wtPath)) {
      await $`git -C ${wtPath} fetch origin ${headRef} --quiet`.nothrow();
      await $`git -C ${wtPath} reset --hard origin/${headRef}`.quiet().nothrow();
      return true;
    }
    await $`git -C ${TELLA_FUSION} worktree prune`.quiet();
    await $`git -C ${TELLA_FUSION} worktree add ${wtPath} -B ${headRef}-michael origin/${headRef}`;
    return false;
  });
  if (reused) return wtPath;

  // Best-effort dep install so checks/builds the agent runs have deps available.
  const webappDir = `${wtPath}/packages/core/webapp`;
  await seedWebappEnv(webappDir);
  try {
    if (await Bun.file(`${webappDir}/package.json`).exists()) {
      await $`cd ${webappDir} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${headRef} (continuing):`, e);
  }

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
 */
export function worktreePathFor(branch: string, repoId?: string): string {
  const repo = getRepo(repoId);
  return repo.sharedCheckout ? repo.repo : `${WORKTREES_DIR}/${repo.wtPrefix}-${branch}`;
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
  opts?: { base?: string },
): Promise<string> {
  const repo = getRepo(repoId);

  // Shared-checkout repos (backstage) don't get a per-session worktree: the
  // session works in the live main checkout on the default branch so its edits
  // hot-reload in the running server. No branch is created or switched — every
  // session stays on the default branch and commits there.
  if (repo.sharedCheckout) return repo.repo;

  const wtPath = `${WORKTREES_DIR}/${repo.wtPrefix}-${branch}`;
  const base = opts?.base;

  await withGitLock(async () => {
    await $`git -C ${repo.repo} fetch origin ${repo.defaultBranch} --quiet`.nothrow();
    if (base) {
      // Stacked worktree: fetch the base (it may be remote-only), then branch off it.
      await $`git -C ${repo.repo} fetch origin ${base} --quiet`.nothrow();
      const startPoint = await resolveStartPoint(repo.repo, base, repo.defaultBranch);
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} ${startPoint}`;
    } else {
      await $`git -C ${repo.repo} worktree add -b ${branch} ${wtPath} origin/${repo.defaultBranch}`;
    }
  });

  // Best-effort dep install — sessions can always run `bun install` themselves.
  // tella-fusion's deps + dev-auth env live under the webapp; other repos
  // (e.g. backstage) install from the repo root.
  try {
    if (repo.id === "tella-fusion") {
      const webappDir = `${wtPath}/packages/core/webapp`;
      await seedWebappEnv(webappDir);
      if (await Bun.file(`${webappDir}/package.json`).exists()) {
        await $`cd ${webappDir} && bun install`.quiet();
      }
    } else if (await Bun.file(`${wtPath}/package.json`).exists()) {
      await $`cd ${wtPath} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${branch} (continuing):`, e);
  }

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
