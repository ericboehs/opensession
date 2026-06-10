import { $ } from "bun";

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
