/**
 * `opensession update` — pull, reinstall dependencies, restart.
 *
 * Modelled on `openclaw update --channel`: one command that moves an install
 * forward and tells you what changed, rather than a documented sequence of git
 * incantations.
 *
 * Deliberately fast-forward only. A self-hosted install may carry local edits
 * (that is half the point of shipping the source), and silently rebasing or
 * resetting over them would be the worst possible failure mode. If the tree
 * has diverged, update stops and says so.
 */

import { REPO_ROOT } from "./paths";
import * as service from "./service";
import { bold, dim, fail, heading, info, ok, run, runInherit, warn } from "./ui";

export type UpdateOptions = { channel?: string; restart?: boolean; check?: boolean };

async function git(args: string[]) {
  return await run(["git", ...args], { cwd: REPO_ROOT });
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

  const branch =
    opts.channel ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout ?? "main";
  const before = (await git(["rev-parse", "--short", "HEAD"])).stdout;

  info(dim(`fetching ${branch} ...`));
  if ((await git(["fetch", "--quiet", "origin", branch])).code !== 0) {
    fail(`could not fetch origin/${branch}`);
    return 1;
  }

  const { stdout: counts } = await git(["rev-list", "--left-right", "--count", `HEAD...FETCH_HEAD`]);
  const [ahead = "0", behind = "0"] = counts.split(/\s+/);

  if (behind === "0") {
    ok(`already up to date`, `${branch} @ ${before}`);
    return 0;
  }
  if (ahead !== "0") {
    fail(
      `local branch has diverged (${ahead} ahead, ${behind} behind)`,
      "reconcile manually — update will not rewrite your history",
    );
    return 1;
  }

  info(`${behind} new commit(s) on ${bold(branch)}`);
  const { stdout: log } = await git([
    "log",
    "--oneline",
    "--no-decorate",
    "-10",
    `HEAD..FETCH_HEAD`,
  ]);
  for (const line of log.split("\n").filter(Boolean)) info(dim(`  ${line}`));

  if (opts.check) {
    info(dim("\n  --check given, stopping before applying"));
    return 0;
  }

  if ((await git(["merge", "--ff-only", "FETCH_HEAD"])).code !== 0) {
    fail("fast-forward failed", "reconcile manually");
    return 1;
  }
  const after = (await git(["rev-parse", "--short", "HEAD"])).stdout;
  ok("updated", `${before} -> ${after}`);

  heading("Dependencies");
  if ((await runInherit(["bun", "install"], REPO_ROOT)) !== 0) {
    fail("bun install failed");
    return 1;
  }
  ok("dependencies installed");

  // Backend changes never take effect without a real restart — the frontend
  // watcher only rebuilds the SPA.
  if (opts.restart !== false && (await service.isInstalled())) {
    heading("Restart");
    if ((await service.control("restart")) === 0) ok("service restarted");
    else warn("restart failed — do it by hand");
  } else if (opts.restart !== false) {
    warn("no service installed", "restart your foreground server to pick this up");
  }

  return 0;
}
