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
import { postIssueComment, removeLabel } from "./github-rest";
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
    writePrState(s);

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
    await postIssueComment(
      pr.number,
      `<!-- michael-simplify -->\n✨ **Michael simplify** — ${result.error ? `errored: ${result.error}` : summary}`,
    );

    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.simplify) { fin.simplify.active = false; fin.simplify.doneSha = pr.headSha; writePrState(fin); }

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
    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.simplify) { fin.simplify.active = false; writePrState(fin); }
  } finally {
    await removeLabel(pr.number, LABEL_SIMPLIFY).catch(() => {});
    releaseLock("code", pr.number);
  }
}
