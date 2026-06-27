/**
 * Behavior 3: `michael-simplify`. One `/simplify` pass on the PR's changes in a
 * PR-branch worktree, push, post a summary, then re-run the review on the result.
 * Removes the label when done.
 */
import { getPrDetails, getPrDiff } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock, getOrInitPrState, writePrState } from "./state";
import { runGithubAgent, authorForLogin, finalSummary } from "./run";
import { buildSimplifyPrompt } from "./prompts";
import { upsertMarkedComment, removeLabel, SIMPLIFY_MARKER } from "./github-rest";
import { LABEL_SIMPLIFY } from "./constants";
import { runReview, type PrRef } from "./review";
import { resolveReviewConfig } from "./webhook";

export async function runSimplify(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
): Promise<void> {
  if (!claimLock("code", pr.number)) {
    console.log(`[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping simplify`);
    return;
  }
  const author = authorForLogin(requestedBy);
  try {
    const details = await getPrDetails(pr.headRef);
    if (!details) {
      console.warn(`[github] no PR details for ${pr.headRef}; skipping simplify`);
      return;
    }
    if (details.state !== "OPEN") return;

    const s = getOrInitPrState(pr.number, pr.headRef);
    s.simplify = { active: true, requestedBy, startedAt: new Date().toISOString() };
    s.activeRun = { kind: "simplify", requestedBy, startedAt: new Date().toISOString() };
    writePrState(s);

    // Immediate progress comment (reused across re-runs by marker) before the slow
    // worktree + agent run; replaced with the result at the end.
    await upsertMarkedComment(pr.number, SIMPLIFY_MARKER, `✨ **Michael simplify** — working on PR #${pr.number}…`);

    const worktreeDir = await createWorktreeForPrBranch(pr.headRef);
    console.log(`[github] Simplifying PR #${pr.number}`);

    const result = await runGithubAgent({
      prNumber: pr.number,
      kind: "simplify",
      prompt: buildSimplifyPrompt(details),
      cwd: worktreeDir,
      mode: "code",
      branch: pr.headRef,
      title: `Simplify · PR #${pr.number} ${details.title}`.slice(0, 100),
      author,
      onSessionCreated,
    });

    const summary = finalSummary(result.text).slice(0, 2000) || "Done.";
    await upsertMarkedComment(
      pr.number,
      SIMPLIFY_MARKER,
      `✨ **Michael simplify** — ${result.error ? `errored: ${result.error}` : summary}`,
    );

    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.simplify) { fin.simplify.active = false; fin.simplify.doneSha = pr.headSha; }
    fin.activeRun = undefined;
    writePrState(fin);

    // Re-review the simplified result (per the "simplify then re-review" decision).
    if (!result.error) {
      const fresh = await getPrDetails(pr.headRef);
      const diff = await getPrDiff(pr.headRef);
      const ref: PrRef = {
        number: pr.number,
        headRef: pr.headRef,
        headSha: diff?.headRefOid || pr.headSha,
        title: fresh?.title || pr.title,
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
    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.simplify) fin.simplify.active = false;
    fin.activeRun = undefined;
    writePrState(fin);
    await removeLabel(pr.number, LABEL_SIMPLIFY).catch(() => {});
    releaseLock("code", pr.number);
  }
}
