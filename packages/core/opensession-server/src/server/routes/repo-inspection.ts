import { basename } from "path";
import { realpathSync } from "fs";
import { parseCsRemote } from "../codestorage/remote";

async function git(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), 30_000);
  const [exitCode, stdout] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stdout: stdout.trim() };
}

export function repoIdFromName(input: string): string {
  const name = basename(input.replace(/[\\/]+$/, "").replace(/\.git$/i, "").replace(/^.*:/, ""));
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  return id || "repo";
}

function githubRepoFromRemote(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = normalized.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i);
  return match?.[1];
}

function defaultBranchFromLsRemote(output: string): string | undefined {
  return output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1];
}

async function hasCommit(path: string, ref: string): Promise<boolean> {
  return (
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path)
  ).exitCode === 0;
}

export async function inspectRepo(repoPath: string): Promise<{
  path: string;
  defaultBranch: string;
  ghRepo?: string;
  cs?: { org: string; repoId: string };
}> {
  const root = await git(["rev-parse", "--show-toplevel"], repoPath);
  if (root.exitCode !== 0 || !root.stdout) throw new Error("Path is not a Git repository");
  const path = realpathSync(root.stdout);
  const [origin, remoteSymref, remoteHead] = await Promise.all([
    git(["remote", "get-url", "origin"], path),
    git(["ls-remote", "--symref", "origin", "HEAD"], path),
    git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      path,
    ),
  ]);
  if (origin.exitCode !== 0 || !origin.stdout) {
    throw new Error("Repository must have an origin remote");
  }

  const defaultBranch =
    defaultBranchFromLsRemote(remoteSymref.stdout) ||
    remoteHead.stdout.replace(/^origin\//, "");
  if (!defaultBranch) {
    throw new Error(
      "Could not determine origin's default branch. Fetch the repository and set origin/HEAD, then try again",
    );
  }

  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  if (!(await hasCommit(path, remoteRef))) {
    await git(
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${defaultBranch}:${remoteRef}`,
      ],
      path,
    );
  }
  if (!(await hasCommit(path, remoteRef))) {
    throw new Error(`Repository must have a commit on origin/${defaultBranch}`);
  }

  const cs = parseCsRemote(origin.stdout);
  return {
    path,
    defaultBranch,
    ghRepo: githubRepoFromRemote(origin.stdout),
    ...(cs ? { cs } : {}),
  };
}

/** Whether a candidate default branch currently exists on origin. */
export async function repoHasBranch(repoPath: string, branch: string): Promise<boolean> {
  return (
    await git(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], repoPath)
  ).exitCode === 0;
}

export async function repoCurrentBranch(repoPath: string): Promise<string | null> {
  const current = await git(["branch", "--show-current"], repoPath);
  return current.exitCode === 0 && current.stdout ? current.stdout : null;
}
