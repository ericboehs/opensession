/**
 * Local git state for a session's worktree — the Conductor-style status header
 * and "Git status" rows (ahead of remote → Push, behind main → Update, dirty
 * tree → Commit). Complements pr-info.ts, which covers the GitHub side.
 *
 * origin/<base> is refreshed with a throttled fetch so "behind main" is honest
 * without hammering the remote from every open panel.
 *
 * Sandbox-aware (sandbox rollout Phase 2): callers may pass a
 * WorkspaceExec (workspaceExecFor) so every git command — including fetch,
 * pull and push, which then use the sandbox's mounted read-only creds — runs
 * inside the session's sandbox. Omitted = the host path, unchanged.
 */
import { $ } from "bun";
import { audited } from "./audit";
import { personaName } from "./config";
import { isSharedCheckoutDir } from "./worktree";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

/** `git -C <dir> <args>` on the host (Bun $) or through the workspace exec.
 *  Throws on non-zero exit, matching the Bun $ .text() call sites here. */
async function gitText(dir: string, args: string[], exec?: WorkspaceExec): Promise<string> {
  const argv = ["git", "-C", dir, ...args];
  if (exec) {
    const r = await exec(argv);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
    return r.stdout;
  }
  return await $`${argv}`.quiet().text();
}

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
  /**
   * This dir is a repo's shared checkout rather than a per-session worktree
   * (OpenSession's own repo works this way — every session edits one tree on
   * the default branch). `uncommittedFiles` is then the union of every
   * concurrent session's in-flight edits and says nothing about this session,
   * so surfaces that present it as "your" work must not show it: offering to
   * commit that count means committing other sessions' half-finished work.
   */
  sharedCheckout: boolean;
}

const FETCH_TTL = 90_000;
const lastFetch = new Map<string, number>();

async function refreshBase(dir: string, baseBranch: string, exec?: WorkspaceExec): Promise<void> {
  const last = lastFetch.get(dir) || 0;
  if (Date.now() - last < FETCH_TTL) return;
  lastFetch.set(dir, Date.now());
  try {
    await gitText(dir, ["fetch", "origin", baseBranch, "--no-tags", "--quiet"], exec);
  } catch {
    // Offline or no remote — counts fall back to the last-known tracking refs.
  }
}

export async function getGitStatus(
  dir: string,
  baseBranch = "main",
  exec?: WorkspaceExec,
): Promise<GitStatusInfo> {
  // Fire-and-forget: the fetch is only there to keep origin/<base> current for
  // the NEXT poll. Awaiting it made every TTL-expired status call block on a
  // network round-trip — the status header polls every 45s, so counts computed
  // from refs one poll old are an honest trade for an instant response.
  void refreshBase(dir, baseBranch, exec);

  let branch: string | null = null;
  try {
    branch = (await gitText(dir, ["branch", "--show-current"], exec)).trim() || null;
  } catch {}

  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  try {
    const counts = (
      await gitText(dir, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], exec)
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
          (await gitText(dir, ["rev-list", "--count", `origin/${baseBranch}..HEAD`], exec)).trim()
        ) || 0;
    } catch {}
  }

  let behindBase = 0;
  try {
    behindBase =
      parseInt(
        (await gitText(dir, ["rev-list", "--count", `HEAD..origin/${baseBranch}`], exec)).trim()
      ) || 0;
  } catch {}

  let uncommittedFiles = 0;
  try {
    const status = await gitText(dir, ["status", "--porcelain"], exec);
    uncommittedFiles = status.split("\n").filter((l) => l.trim()).length;
  } catch {}

  return {
    branch,
    hasUpstream,
    ahead,
    behind,
    behindBase,
    baseBranch,
    uncommittedFiles,
    sharedCheckout: isSharedCheckoutDir(dir),
  };
}

/**
 * Update the worktree — the Pull/Update action in the status header. Pulling
 * the branch's own upstream stays fast-forward-only. Updating from the base
 * merges origin/<base> locally: a feature branch necessarily diverges from its
 * base, so `pull --ff-only origin main` could never perform the update the UI
 * promised. The merge preserves published history and the existing Push action
 * can publish it without a force-push.
 */
export async function gitPull(
  dir: string,
  fromBase?: string,
  exec?: WorkspaceExec,
): Promise<{ ok: true } | { error: string }> {
  return audited(
    {
      context: "sessions",
      action: "git_pull",
      args: { dir, fromBase: fromBase || null, sandboxed: exec?.sandboxed || undefined },
    },
    async () => {
      async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
        if (exec) {
          const r = await exec(args);
          return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
        }
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr, code };
      }

      if (!fromBase) {
        const result = await run(["git", "-C", dir, "pull", "--ff-only"]);
        if (result.code !== 0)
          return { error: (result.stderr || "git pull failed").trim().slice(0, 300) } as const;
        return { ok: true } as const;
      }

      const status = await run(["git", "-C", dir, "status", "--porcelain"]);
      if (status.code !== 0)
        return { error: (status.stderr || "Could not inspect the worktree").trim().slice(0, 300) } as const;
      if (status.stdout.trim())
        return { error: "Commit or discard the uncommitted changes before updating." } as const;

      const fetch = await run(["git", "-C", dir, "fetch", "origin", fromBase, "--no-tags", "--quiet"]);
      if (fetch.code !== 0)
        return { error: (fetch.stderr || `Could not fetch origin/${fromBase}`).trim().slice(0, 300) } as const;

      const merge = await run([
        "git",
        "-C",
        dir,
        "merge",
        "--no-edit",
        "--no-autostash",
        `origin/${fromBase}`,
      ]);
      if (merge.code !== 0) {
        const mergeState = await run(["git", "-C", dir, "rev-parse", "--verify", "MERGE_HEAD"]);
        if (mergeState.code === 0) {
          const abort = await run(["git", "-C", dir, "merge", "--abort"]);
          if (abort.code !== 0)
            return {
              error: `Update failed and Git could not restore the worktree: ${(
                abort.stderr || merge.stderr || merge.stdout || "unknown error"
              )
                .trim()
                .slice(0, 220)}`,
            } as const;
          return {
            error: `Could not update automatically because this branch conflicts with ${fromBase}. Ask ${personaName()} to resolve the conflicts.`,
          } as const;
        }
        return {
          error: (merge.stderr || merge.stdout || "Could not update the branch").trim().slice(0, 300),
        } as const;
      }
      return { ok: true } as const;
    }
  );
}

/**
 * Push the worktree's current branch (sets upstream on first push). Audited —
 * this publishes commits. Never forces; a rejected push surfaces as an error
 * for the human (or the session) to resolve.
 */
export async function gitPush(
  dir: string,
  branch: string,
  exec?: WorkspaceExec,
): Promise<{ ok: true } | { error: string }> {
  return audited(
    {
      context: "sessions",
      action: "git_push",
      args: { dir, branch, sandboxed: exec?.sandboxed || undefined },
    },
    async () => {
      const args = ["git", "-C", dir, "push", "-u", "origin", "HEAD"];
      let err: string;
      let code: number;
      if (exec) {
        const r = await exec(args);
        err = r.stderr;
        code = r.exitCode;
      } else {
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        [err, code] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
      }
      if (code !== 0) return { error: (err || "git push failed").slice(0, 300) } as const;
      return { ok: true } as const;
    }
  );
}
