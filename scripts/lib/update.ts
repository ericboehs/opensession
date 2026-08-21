/**
 * `opensession update` — pull upstream, reconcile, reinstall deps, deploy.
 *
 * Modelled on `openclaw update --channel`: one command that moves an install
 * forward and tells you what changed, rather than a documented sequence of git
 * incantations.
 *
 * Two checkout topologies (docs/self-development.md):
 *
 *  - origin-only: the checkout tracks one remote. Deliberately fast-forward
 *    only — a self-hosted install may carry local edits (that is half the
 *    point of shipping the source), and silently rebasing or resetting over
 *    them would be the worst possible failure mode. If the tree has diverged,
 *    update stops and says so.
 *  - fork: `origin` is the operator's own fork (self-development pushes land
 *    there) and a second remote points at the upstream project. Updates come
 *    FROM upstream and, once the instance has self-developed, can never
 *    fast-forward again — so here update performs an honest merge (a merge
 *    commit, never a rewrite; conflicts abort cleanly) and pushes the result
 *    back to the fork.
 *
 * The restart goes through deploy/self-deploy.sh when it can (service
 * installed + passwordless sudo): that buys the last-known-good pin, the
 * bootId-stable health gate, the watchdog window, and rollback posture —
 * with `--pin` set to the pre-update commit, since by then the merge has
 * already moved HEAD. Otherwise it falls back to a plain service restart.
 */

import { existsSync } from "fs";
import { join } from "path";
import { REPO_ROOT } from "./paths";
import * as service from "./service";
import { bold, dim, fail, heading, info, ok, run, runInherit, warn } from "./ui";

export type UpdateOptions = { channel?: string; restart?: boolean; check?: boolean };

/** The upstream project this source came from. */
const UPSTREAM_URL_RE = /github\.com[/:]tellahq\/opensession(\.git)?$/;

export interface Remote {
  name: string;
  url: string;
}

/** Parse `git remote -v` output into unique fetch remotes. */
export function parseRemotes(remoteV: string): Remote[] {
  const seen = new Map<string, string>();
  for (const line of remoteV.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

export interface Topology {
  /** Remote updates are pulled from. */
  source: string;
  /** fork = merge allowed + push back to origin; origin = ff-only. */
  kind: "origin" | "fork";
}

/**
 * Where updates come from. Fork topology iff origin is NOT the upstream
 * project and some other remote is — then that remote is the source and a
 * merge is legitimate (the local commits are the operator's own fork history).
 * Everything else (origin-only clones, origin = upstream, no origin at all)
 * stays the conservative ff-only path against origin.
 */
export function classifyTopology(remotes: Remote[]): Topology {
  const origin = remotes.find((r) => r.name === "origin");
  const upstream = remotes.find(
    (r) => r.name !== "origin" && UPSTREAM_URL_RE.test(r.url),
  );
  if (origin && !UPSTREAM_URL_RE.test(origin.url) && upstream) {
    return { source: upstream.name, kind: "fork" };
  }
  return { source: "origin", kind: "origin" };
}

async function git(args: string[]) {
  return await run(["git", ...args], { cwd: REPO_ROOT });
}

/** Can this shell launch the fixed deploy helper and restart without prompting? */
async function passwordlessRoot(): Promise<boolean> {
  if (process.getuid?.() === 0) return true;
  const systemctl = Bun.which("systemctl") || "/usr/bin/systemctl";
  const [helper, restart] = await Promise.all([
    run(["sudo", "-n", "/usr/local/libexec/opensession-run-host", "check"]),
    run(["sudo", "-n", "-l", systemctl, "restart", "opensession.service"]),
  ]);
  if (helper.code === 0 && restart.code === 0) return true;
  // Existing self-hosted instances used broad passwordless sudo for the
  // transient deploy unit. Keep that one-release bootstrap path working until
  // `opensession service install` replaces it with the fixed helper grant.
  return (await run(["sudo", "-n", "true"])).code === 0;
}

export async function update(opts: UpdateOptions = {}): Promise<number> {
  heading("Update");

  const { code: isRepo } = await git(["rev-parse", "--git-dir"]);
  if (isRepo !== 0) {
    fail("not a git checkout", REPO_ROOT);
    return 1;
  }

  // Refuse to move a dirty tree — the user's own edits are more valuable than
  // being current, and a failed merge here leaves a live server half-updated.
  const { stdout: dirty } = await git(["status", "--porcelain"]);
  if (dirty) {
    fail("working tree has uncommitted changes", "commit or stash them first");
    info(dim(dirty.split("\n").slice(0, 10).join("\n  ")));
    return 1;
  }

  const remotes = parseRemotes((await git(["remote", "-v"])).stdout ?? "");
  const topology = classifyTopology(remotes);
  if (topology.kind === "fork") {
    info(dim(`fork topology: updates from ${bold(topology.source)}, pushes to origin`));
  }

  const branch =
    opts.channel ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout ?? "main";
  const before = (await git(["rev-parse", "--short", "HEAD"])).stdout;
  const beforeFull = (await git(["rev-parse", "HEAD"])).stdout;

  info(dim(`fetching ${topology.source}/${branch} ...`));
  if ((await git(["fetch", "--quiet", topology.source, branch])).code !== 0) {
    fail(`could not fetch ${topology.source}/${branch}`);
    return 1;
  }

  const { stdout: counts } = await git(["rev-list", "--left-right", "--count", `HEAD...FETCH_HEAD`]);
  const [ahead = "0", behind = "0"] = counts.split(/\s+/);

  if (behind === "0") {
    ok(`already up to date`, `${branch} @ ${before}`);
    return 0;
  }

  info(`${behind} new commit(s) on ${bold(`${topology.source}/${branch}`)}`);
  const { stdout: log } = await git([
    "log",
    "--oneline",
    "--no-decorate",
    "-10",
    `HEAD..FETCH_HEAD`,
  ]);
  for (const line of log.split("\n").filter(Boolean)) info(dim(`  ${line}`));

  if (ahead !== "0" && topology.kind === "origin") {
    fail(
      `local branch has diverged (${ahead} ahead, ${behind} behind)`,
      "reconcile manually — update will not rewrite your history",
    );
    if (remotes.some((r) => r.name === "origin" && UPSTREAM_URL_RE.test(r.url))) {
      info(
        dim(
          "  self-developing against the upstream clone? Fork it and point origin\n" +
            "  at the fork (docs/self-development.md) — update then merges for you.",
        ),
      );
    }
    return 1;
  }

  if (opts.check) {
    if (ahead !== "0")
      info(dim(`\n  ${ahead} local commit(s) — update will create a merge commit`));
    info(dim("  --check given, stopping before applying"));
    return 0;
  }

  if (ahead === "0") {
    if ((await git(["merge", "--ff-only", "FETCH_HEAD"])).code !== 0) {
      fail("fast-forward failed", "reconcile manually");
      return 1;
    }
  } else {
    // Fork topology with local self-development commits: an honest merge
    // commit is the correct reconciliation (never a rebase/reset — this
    // checkout may be live). Conflicts abort back to the pre-merge tree.
    info(dim(`merging ${topology.source}/${branch} into ${branch} (${ahead} local commit(s))`));
    const merge = await git([
      "merge",
      "--no-edit",
      "-m",
      `Merge ${topology.source}/${branch} (opensession update)`,
      "FETCH_HEAD",
    ]);
    if (merge.code !== 0) {
      await git(["merge", "--abort"]);
      fail(
        "merge conflicts with upstream",
        `resolve by hand: git merge ${topology.source}/${branch}`,
      );
      return 1;
    }
  }
  const after = (await git(["rev-parse", "--short", "HEAD"])).stdout;
  ok("updated", `${before} -> ${after}`);

  // Keep the fork current so session pushes and deploy_self (which
  // fast-forwards from origin) see the merged history.
  if (topology.kind === "fork") {
    if ((await git(["push", "origin", branch])).code === 0) {
      ok(`pushed ${branch} to origin`);
    } else {
      warn("could not push to origin", `push by hand: git push origin ${branch}`);
    }
  }

  heading("Dependencies");
  if ((await runInherit(["bun", "install"], REPO_ROOT)) !== 0) {
    fail("bun install failed");
    return 1;
  }
  ok("dependencies installed");

  // Backend changes never take effect without a real restart — the frontend
  // watcher only rebuilds the SPA. Prefer the health-gated deploy script: it
  // pins the PRE-update commit as last-known-good, gates the restart on a
  // bootId-stable /api/health streak, and opens the watchdog window.
  if (opts.restart === false) return 0;
  const selfDeploy = join(REPO_ROOT, "deploy", "self-deploy.sh");
  if ((await service.isInstalled()) && existsSync(selfDeploy) && (await passwordlessRoot())) {
    heading("Deploy (health-gated)");
    const code = await runInherit(
      [selfDeploy, "--sha", "HEAD", "--pin", beforeFull],
      REPO_ROOT,
    );
    if (code === 0) {
      ok("restarted and healthy", `rollback pin ${before}`);
    } else {
      fail(
        "deploy did not come back healthy",
        "see ~/.opensession-deploy/last-result.json and self-deploy.log",
      );
      return 1;
    }
  } else if (await service.isInstalled()) {
    heading("Restart");
    if ((await service.control("restart")) === 0) ok("service restarted");
    else warn("restart failed — do it by hand");
  } else {
    warn("no service installed", "restart your foreground server to pick this up");
  }

  if ((await service.isInstalled()) && !existsSync("/usr/local/libexec/opensession-run-host")) {
    warn(
      "detached executor not installed",
      "run `opensession service install` once to install the fixed launch helper",
    );
  }

  return 0;
}
