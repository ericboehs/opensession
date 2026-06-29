/**
 * Behavior: `michael-adversarial`. Runs tella-fusion's adversarial-code-review
 * skill (two independent hostile review passes, adjudicated) in code mode, with
 * Michael responsible for implementing the accepted findings, then pushes any
 * resulting changes to the PR branch and posts a summary. One-shot.
 */
import { getPrDetails } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock, getOrInitPrState, writePrState } from "./state";
import { runGithubAgent, authorForLogin, finalSummary, sessionUrl } from "./run";
import { buildAdversarialPrompt } from "./prompts";
import { postOrEditComment, removeLabel, ADVERSARIAL_MARKER } from "./github-rest";
import { LABEL_ADVERSARIAL } from "./constants";
import type { PrRef } from "./review";

export async function runAdversarial(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number)) {
    console.log(`[github] a code action is already running for PR #${pr.number}, skipping adversarial`);
    return;
  }
  const author = authorForLogin(requestedBy);
  try {
    const details = await getPrDetails(pr.headRef);
    if (!details) {
      console.warn(`[github] no PR details for ${pr.headRef}; skipping adversarial`);
      return;
    }
    if (details.state !== "OPEN") return;

    const startedAt = new Date().toISOString();
    const link = `[📺 open session](${sessionUrl(pr.number, "adversarial")})`;
    const s = getOrInitPrState(pr.number, details.headRefName);
    const reuseId = s.activeRun?.kind === "adversarial" ? s.activeRun.progressCommentId : undefined;
    const progressId = await postOrEditComment(
      pr.number,
      reuseId,
      `${ADVERSARIAL_MARKER}\n🔍 **Michael adversarial review** — running two independent review passes on PR #${pr.number}… · ${link}`,
    );
    s.activeRun = { kind: "adversarial", requestedBy, startedAt, progressCommentId: progressId ?? undefined, steer };
    writePrState(s);

    const worktreeDir = await createWorktreeForPrBranch(details.headRefName);
    console.log(`[github] Adversarial review on PR #${pr.number}`);

    const result = await runGithubAgent({
      prNumber: pr.number,
      kind: "adversarial",
      prompt: buildAdversarialPrompt(details, steer),
      cwd: worktreeDir,
      mode: "code",
      branch: details.headRefName,
      title: `Adversarial · PR #${pr.number} ${details.title}`.slice(0, 100),
      author,
      onSessionCreated,
    });

    const summary = finalSummary(result.text).slice(0, 6000) || "Done.";
    await postOrEditComment(
      pr.number,
      progressId ?? undefined,
      `${ADVERSARIAL_MARKER}\n🔍 **Michael adversarial review** — ${result.error ? `errored: ${result.error}` : summary} · ${link}`,
    );
  } catch (e) {
    console.error(`[github] adversarial error for PR #${pr.number}:`, e);
  } finally {
    // Clear the recovery flag on completion; a killed process leaves it set so the
    // github agent re-runs it on startup.
    const fin = getOrInitPrState(pr.number, pr.headRef);
    fin.activeRun = undefined;
    writePrState(fin);
    await removeLabel(pr.number, LABEL_ADVERSARIAL).catch(() => {});
    releaseLock("code", pr.number);
  }
}
