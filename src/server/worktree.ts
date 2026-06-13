import { $ } from "bun";
import { existsSync } from "fs";
import type { UnifiedSession } from "./types";

const TELLA_FUSION = "/home/ubuntu/projects/tella-fusion";
const WORKTREES_DIR = "/home/ubuntu/worktrees";

export interface WorktreeInfo {
  branch: string;
  path: string;
}

export async function listWorktrees(): Promise<WorktreeInfo[]> {
  try {
    const result = await $`git -C ${TELLA_FUSION} worktree list --porcelain`.text();
    const worktrees: WorktreeInfo[] = [];
    let currentPath = "";
    let currentBranch = "";

    for (const line of result.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentBranch = line.slice("branch refs/heads/".length);
      } else if (line === "") {
        if (currentPath && currentBranch && currentPath.startsWith(WORKTREES_DIR)) {
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

export async function removeWorktree(branch: string): Promise<void> {
  try {
    // Use the wt delete script if available, otherwise git worktree remove
    const wtPath = `${WORKTREES_DIR}/tella-fusion-${branch}`;
    if (await Bun.file("/home/ubuntu/bin/wt").exists()) {
      await $`/home/ubuntu/bin/wt delete ${branch}`.quiet();
    } else {
      await $`git -C ${TELLA_FUSION} worktree remove ${wtPath} --force`.quiet();
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
export async function reviveWorktree(branch: string): Promise<string> {
  const wtPath = `${WORKTREES_DIR}/tella-fusion-${branch}`;
  if (existsSync(wtPath)) return wtPath;

  await $`git -C ${TELLA_FUSION} worktree prune`.quiet();
  const hasBranch =
    (await $`git -C ${TELLA_FUSION} show-ref --verify --quiet refs/heads/${branch}`.nothrow()).exitCode === 0;
  if (hasBranch) {
    await $`git -C ${TELLA_FUSION} worktree add ${wtPath} ${branch}`;
  } else {
    await $`git -C ${TELLA_FUSION} fetch origin main --quiet`;
    await $`git -C ${TELLA_FUSION} worktree add -b ${branch} ${wtPath} origin/main`;
  }
  return wtPath;
}

export async function createWorktree(branch: string): Promise<string> {
  const wtPath = `${WORKTREES_DIR}/tella-fusion-${branch}`;

  await $`git -C ${TELLA_FUSION} fetch origin main --quiet`;
  await $`git -C ${TELLA_FUSION} worktree add -b ${branch} ${wtPath} origin/main`;

  // Best-effort dep install — sessions can always run `bun install` themselves
  const webappDir = `${wtPath}/packages/core/webapp`;
  try {
    if (await Bun.file(`${webappDir}/package.json`).exists()) {
      await $`cd ${webappDir} && bun install`.quiet();
    }
  } catch (e) {
    console.warn(`[worktree] bun install failed for ${branch} (continuing):`, e);
  }

  return wtPath;
}
