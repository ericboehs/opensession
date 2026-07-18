/**
 * Behavior 3: the `os-simplify` label (legacy `michael-simplify`). One `/simplify` pass on the PR's changes in a
 * PR-branch worktree, push, post a summary, then re-run the review on the result.
 * Removes the label when done.
 */
import { personaName } from "../../server/config";
import { getPrDetails, getPrDiff } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock, getOrInitPrState, writePrState } from "./state";
import { runGithubAgent, authorForLogin, finalSummary, sessionUrl } from "./run";
import { buildSimplifyPrompt } from "./prompts";
import { postOrEditComment, removeLabel, SIMPLIFY_MARKER } from "./github-rest";
import { LABEL_SIMPLIFY, labelAliases, repoForFullName } from "./constants";
import { runReview, type PrRef } from "./review";
import { resolveReviewConfig } from "./webhook";

export async function runSimplify(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number, pr.ghRepo)) {
    console.log(`[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping simplify`);
    return;
  }
  const author = authorForLogin(requestedBy);
  try {
    // By number, not branch — by-branch lookups lag for fresh PRs (see runReview).
    const details = await getPrDetails(pr.number ? String(pr.number) : pr.headRef, pr.ghRepo || undefined);
    if (!details) {
      console.warn(`[github] no PR details for #${pr.number} (${pr.headRef}); skipping simplify`);
      return;
    }
    if (details.state !== "OPEN") return;

    const startedAt = new Date().toISOString();
    const link = `[📺 open session](${sessionUrl(pr.number, "simplify", pr.ghRepo)})`;
    const s = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    // Reuse this run's comment only when recovering an interrupted run; a fresh
    // trigger (no activeRun) posts a new comment.
    const reuseId = s.activeRun?.kind === "simplify" ? s.activeRun.progressCommentId : undefined;
    const progressId = await postOrEditComment(
      pr.number,
      reuseId,
      `${SIMPLIFY_MARKER}\n✨ **${personaName()} simplify** — working on PR #${pr.number}… · ${link}`,
      pr.ghRepo,
    );
    s.simplify = { active: true, requestedBy, startedAt };
    s.activeRun = { kind: "simplify", requestedBy, startedAt, progressCommentId: progressId ?? undefined, steer };
    writePrState(s);

    const worktreeDir = await createWorktreeForPrBranch(
      pr.headRef,
      pr.ghRepo ? repoForFullName(pr.ghRepo)?.id : undefined,
    );
    console.log(`[github] Simplifying PR #${pr.number}`);

    const result = await runGithubAgent({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "simplify",
      prompt: buildSimplifyPrompt(details, steer),
      cwd: worktreeDir,
      mode: "code",
      branch: pr.headRef,
      title: `Simplify · PR #${pr.number} ${details.title}`.slice(0, 100),
      author,
      onSessionCreated,
    });

    const summary = finalSummary(result.text).slice(0, 2000) || "Done.";
    await postOrEditComment(
      pr.number,
      progressId ?? undefined,
      `${SIMPLIFY_MARKER}\n✨ **${personaName()} simplify** — ${result.error ? `errored: ${result.error}` : summary} · ${link}`,
      pr.ghRepo,
    );

    const fin = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    if (fin.simplify) { fin.simplify.active = false; fin.simplify.doneSha = pr.headSha; }
    fin.activeRun = undefined;
    writePrState(fin);

    // Re-review the simplified result (per the "simplify then re-review" decision).
    if (!result.error) {
      const fresh = await getPrDetails(pr.headRef, pr.ghRepo || undefined);
      const diff = await getPrDiff(pr.headRef, pr.ghRepo || undefined);
      const ref: PrRef = {
        number: pr.number,
        headRef: pr.headRef,
        headSha: diff?.headRefOid || pr.headSha,
        title: fresh?.title || pr.title,
        ...(pr.ghRepo ? { ghRepo: pr.ghRepo } : {}),
      };
      await runReview(ref, resolveReviewConfig().config, onSessionCreated).catch((e) =>
        console.error(`[github] post-simplify review failed for PR #${pr.number}:`, e),
      );
    }
  } catch (e) {
    console.error(`[github] simplify error for PR #${pr.number}:`, e);
  } finally {
    // Clear the recovery flag on any completion (success/handled error). If the
    // process is KILLED mid-run, finally doesn't run → activeRun persists → the
    // github agent re-runs it on startup.
    const fin = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    if (fin.simplify) fin.simplify.active = false;
    fin.activeRun = undefined;
    writePrState(fin);
    for (const name of labelAliases(LABEL_SIMPLIFY)) {
      await removeLabel(pr.number, name, pr.ghRepo).catch(() => {});
    }
    releaseLock("code", pr.number, pr.ghRepo);
  }
}
