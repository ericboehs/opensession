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

export async function createWorktree(branch: string): Promise<string> {
  const wtPath = `${WORKTREES_DIR}/tella-fusion-${branch}`;

  await $`git -C ${TELLA_FUSION} fetch origin main --quiet`;
  await $`git -C ${TELLA_FUSION} worktree add -b ${branch} ${wtPath} main`;

  // Install deps
  const webappDir = `${wtPath}/packages/webapp`;
  await $`cd ${webappDir} && bun install`.quiet();

  return wtPath;
}
