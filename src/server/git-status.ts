/**
 * Local git state for a session's worktree — the Conductor-style status header
 * and "Git status" rows (ahead of remote → Push, behind main → Update, dirty
 * tree → Commit). Complements pr-info.ts, which covers the GitHub side.
 *
 * origin/<base> is refreshed with a throttled fetch so "behind main" is honest
 * without hammering the remote from every open panel.
 */
import { $ } from "bun";
import { audited } from "./audit";

export interface GitStatusInfo {
  branch: string | null;
  /** Branch has an upstream (has been pushed at least once). */
  hasUpstream: boolean;
  /** Commits ahead of / behind the upstream tracking ref. */
  ahead: number;
  behind: number;
  /** Commits on origin/<base> that this branch doesn't have. */
  behindBase: number;
  baseBranch: string;
  /** Dirty files in the working tree (staged + unstaged + untracked). */
  uncommittedFiles: number;
}

const FETCH_TTL = 90_000;
const lastFetch = new Map<string, number>();

async function refreshBase(dir: string, baseBranch: string): Promise<void> {
  const last = lastFetch.get(dir) || 0;
  if (Date.now() - last < FETCH_TTL) return;
  lastFetch.set(dir, Date.now());
  try {
    await $`git -C ${dir} fetch origin ${baseBranch} --no-tags --quiet`.quiet();
  } catch {
    // Offline or no remote — counts fall back to the last-known tracking refs.
  }
}

export async function getGitStatus(
  dir: string,
  baseBranch = "main"
): Promise<GitStatusInfo> {
  await refreshBase(dir, baseBranch);

  let branch: string | null = null;
  try {
    branch = (await $`git -C ${dir} branch --show-current`.quiet().text()).trim() || null;
  } catch {}

  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  try {
    const counts = (
      await $`git -C ${dir} rev-list --left-right --count @{upstream}...HEAD`.quiet().text()
    ).trim();
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n) || 0);
    hasUpstream = true;
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // No upstream — every local commit past the base is effectively unpushed.
    try {
      ahead =
        parseInt(
          (
            await $`git -C ${dir} rev-list --count origin/${baseBranch}..HEAD`.quiet().text()
          ).trim()
        ) || 0;
    } catch {}
  }

  let behindBase = 0;
  try {
    behindBase =
      parseInt(
        (await $`git -C ${dir} rev-list --count HEAD..origin/${baseBranch}`.quiet().text()).trim()
      ) || 0;
  } catch {}

  let uncommittedFiles = 0;
  try {
    const status = await $`git -C ${dir} status --porcelain`.quiet().text();
    uncommittedFiles = status.split("\n").filter((l) => l.trim()).length;
  } catch {}

  return { branch, hasUpstream, ahead, behind, behindBase, baseBranch, uncommittedFiles };
}

/**
 * Push the worktree's current branch (sets upstream on first push). Audited —
 * this publishes commits. Never forces; a rejected push surfaces as an error
 * for the human (or the session) to resolve.
 */
export async function gitPush(
  dir: string,
  branch: string
): Promise<{ ok: true } | { error: string }> {
  return audited(
    { context: "sessions", action: "git_push", args: { dir, branch } },
    async () => {
      const proc = Bun.spawn(["git", "-C", dir, "push", "-u", "origin", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [err, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "git push failed").slice(0, 300) } as const;
      return { ok: true } as const;
    }
  );
}
