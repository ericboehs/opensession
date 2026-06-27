/**
 * Behavior 2: `michael-auto-fix`. Checks out the PR head branch in a dedicated
 * worktree, fixes its own review findings + failing CI, pushes to the PR branch,
 * polls CI, and re-fixes until green — bounded so it can never run away. Pushes
 * trigger a fresh review via the normal `synchronize` webhook (review is
 * comment-only, so no loop). Removes the label when it finishes.
 */
import { $ } from "bun";
import { getPrDetails, type PrDetails } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import {
  claimLock,
  releaseLock,
  getOrInitPrState,
  writePrState,
  readPrState,
} from "./state";
import { runGithubAgent, authorForLogin } from "./run";
import { buildAutoFixPrompt } from "./prompts";
import { postIssueComment, editIssueComment, removeLabel, listReviewComments, listReviews, BOT_LOGIN } from "./github-rest";
import { LABEL_AUTOFIX } from "./constants";
import type { PrRef } from "./review";

const MAX_ITERATIONS = 5;
const WALL_CLOCK_MS = 60 * 60 * 1000; // abandon a loop running longer than an hour
const CHECK_POLL_MS = 30 * 1000;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

const REPO = "tellahq/tella-fusion";

async function headSha(headRef: string): Promise<string> {
  try {
    const raw = await $`gh pr view ${headRef} --repo ${REPO} --json headRefOid`.quiet().text();
    return JSON.parse(raw).headRefOid || "";
  } catch {
    return "";
  }
}

interface CiState {
  settled: boolean;
  green: boolean;
  failing: string[];
}

function evaluateChecks(details: PrDetails | null): CiState {
  const checks = details?.checks || [];
  if (!checks.length) return { settled: true, green: true, failing: [] }; // no CI configured
  const pending = checks.filter((c) => c.status !== "COMPLETED");
  const failing = checks
    .filter((c) => c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion))
    .map((c) => `${c.name}${c.conclusion ? ` (${c.conclusion})` : ""}`);
  return { settled: pending.length === 0, green: pending.length === 0 && failing.length === 0, failing };
}

/** Poll CI until it settles (or times out). */
async function waitForChecks(headRef: string): Promise<CiState> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let last: CiState = { settled: false, green: false, failing: [] };
  while (Date.now() < deadline) {
    const details = await getPrDetails(headRef);
    last = evaluateChecks(details);
    if (last.settled) return last;
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
  }
  return last; // timed out — return whatever we last saw
}

export async function runAutoFix(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  resuming = false,
): Promise<void> {
  if (!claimLock("code", pr.number)) {
    console.log(`[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping auto-fix`);
    return;
  }

  const author = authorForLogin(requestedBy);
  let statusCommentId: number | undefined;

  const updateStatus = async (text: string) => {
    const body = `<!-- michael-autofix -->\n🛠️ **Michael auto-fix** — ${text}`;
    if (statusCommentId) {
      await editIssueComment(statusCommentId, body);
    } else {
      const id = await postIssueComment(pr.number, body);
      if (id) {
        statusCommentId = id;
        const s = getOrInitPrState(pr.number, pr.headRef);
        s.autoFix = { ...(s.autoFix || { active: true, iterations: 0, startedAt: new Date().toISOString() }), statusCommentId: id };
        writePrState(s);
      }
    }
  };

  try {
    const prior = readPrState(pr.number)?.autoFix;
    statusCommentId = prior?.statusCommentId;
    const startedAt = resuming && prior?.startedAt ? prior.startedAt : new Date().toISOString();
    let iterations = resuming ? prior?.iterations || 0 : 0;

    const s = getOrInitPrState(pr.number, pr.headRef);
    s.autoFix = { active: true, iterations, startedAt, statusCommentId, requestedBy, worktreeDir: prior?.worktreeDir, lastPushedSha: prior?.lastPushedSha };
    writePrState(s);

    // Post the first status BEFORE the (slow) worktree checkout so the PR shows it's working ASAP.
    await updateStatus(resuming ? `resuming (iteration ${iterations + 1}/${MAX_ITERATIONS})…` : `starting (up to ${MAX_ITERATIONS} iterations) — setting up a worktree…`);
    const worktreeDir = await createWorktreeForPrBranch(pr.headRef);

    // Baseline to the CURRENT head so an iteration that pushes nothing compares
    // equal (no false "pushed" / false success on iteration 1).
    const baseSha = prior?.lastPushedSha || (await headSha(pr.headRef));
    let lastPushedSha = baseSha;
    let outcome = "";

    while (iterations < MAX_ITERATIONS) {
      if (Date.now() - Date.parse(startedAt) > WALL_CLOCK_MS) {
        outcome = "⚠️ Stopped — exceeded the 1-hour time budget. Handing back to humans.";
        break;
      }
      iterations++;
      const details = await getPrDetails(pr.headRef);
      if (!details) { outcome = "⚠️ Could not load PR details — stopping."; break; }
      if (details.state !== "OPEN") { outcome = `PR is ${details.state.toLowerCase()} — stopping.`; break; }

      const ciBefore = evaluateChecks(details);
      const reviewSummary = await fetchReviewFindings(pr.number);
      await updateStatus(`iteration ${iterations}/${MAX_ITERATIONS}: working on fixes…`);

      const prompt = buildAutoFixPrompt(details, reviewSummary, ciBefore.failing, iterations);
      const result = await runGithubAgent({
        prNumber: pr.number,
        kind: "autofix",
        prompt,
        cwd: worktreeDir,
        mode: "code",
        branch: pr.headRef,
        title: `Auto-fix · PR #${pr.number} ${details.title}`.slice(0, 100),
        resume: iterations > 1 || resuming,
        author,
        onSessionCreated,
      });

      const newSha = await headSha(pr.headRef);
      const pushedSomething = !!newSha && newSha !== lastPushedSha;
      lastPushedSha = newSha || lastPushedSha;
      const remaining = parseRemaining(result.text);

      const st = getOrInitPrState(pr.number, pr.headRef);
      st.autoFix = { active: true, iterations, startedAt, statusCommentId, requestedBy, worktreeDir, lastPushedSha };
      writePrState(st);

      if (result.error) { outcome = `⚠️ Stopped — the fix run errored: ${result.error}`; break; }

      if (!pushedSomething) {
        // Nothing changed this round.
        if (ciBefore.green && remaining === "none") { outcome = "✅ Nothing left to fix — CI green and findings addressed."; break; }
        outcome = remaining && remaining !== "none"
          ? `⚠️ Stopping — no further changes were made. Remaining: ${remaining}`
          : "⚠️ Stopping — the fixer made no further changes.";
        break;
      }

      await updateStatus(`iteration ${iterations}/${MAX_ITERATIONS}: pushed \`${lastPushedSha.slice(0, 7)}\`, waiting for CI…`);
      const ci = await waitForChecks(pr.headRef);

      if (ci.green && remaining === "none") { outcome = `✅ Auto-fix complete — CI green, findings addressed (\`${lastPushedSha.slice(0, 7)}\`).`; break; }
      if (!ci.settled) { outcome = `⏳ Pushed \`${lastPushedSha.slice(0, 7)}\` but CI didn't settle within the timeout. Handing back to humans.`; break; }
      if (ci.failing.length && iterations >= 2) { outcome = `⚠️ CI still failing after ${iterations} attempts (${ci.failing.join(", ")}). Handing back to humans.`; break; }
      // else: loop again with the new failing checks / findings
    }

    if (!outcome && iterations >= MAX_ITERATIONS) {
      outcome = `⚠️ Reached the ${MAX_ITERATIONS}-iteration cap. Handing back to humans.`;
    }
    await updateStatus(outcome || "done.");

    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.autoFix) { fin.autoFix.active = false; fin.autoFix.iterations = iterations; fin.autoFix.lastPushedSha = lastPushedSha; writePrState(fin); }

    // Refresh the pinned review against the fixed code. The auto-fix push won't
    // trigger a `synchronize` review on its own (it's authored by the bot account,
    // which the webhook guard skips), so the summary would otherwise show stale
    // findings. Only when we actually pushed something.
    if (lastPushedSha && lastPushedSha !== baseSha) {
      const { runReview } = await import("./review");
      const { resolveReviewConfig } = await import("./webhook");
      const fresh = await getPrDetails(pr.headRef);
      const ref: PrRef = { number: pr.number, headRef: pr.headRef, headSha: lastPushedSha, title: fresh?.title || pr.title };
      await runReview(ref, resolveReviewConfig().config, onSessionCreated).catch((e) =>
        console.error(`[github] post-autofix review failed for PR #${pr.number}:`, e),
      );
    }
  } catch (e) {
    console.error(`[github] auto-fix error for PR #${pr.number}:`, e);
    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.autoFix) { fin.autoFix.active = false; writePrState(fin); }
    await updateStatus(`⚠️ Auto-fix errored: ${(e as any)?.message || e}`).catch(() => {});
  } finally {
    await removeLabel(pr.number, LABEL_AUTOFIX).catch(() => {});
    releaseLock("code", pr.number);
  }
}

function parseRemaining(text: string): string {
  const m = (text || "").match(/REMAINING_FINDINGS:\s*(.+)\s*$/im);
  if (!m) return "";
  const v = m[1].trim();
  return v.toLowerCase() === "none" ? "none" : v;
}

/**
 * All open review feedback on the PR, formatted for the fix prompt — inline
 * comments AND review summaries, from EVERY reviewer (Michael, Greptile, humans),
 * each tagged with its author so the agent addresses them all (not just Michael's,
 * not just CI). Skips outdated inline comments and Michael's own boilerplate review
 * body. Returns "" when there's nothing.
 */
async function fetchReviewFindings(prNumber: number): Promise<string> {
  const [comments, reviews] = await Promise.all([
    listReviewComments(prNumber),
    listReviews(prNumber),
  ]);
  const lines: string[] = [];
  for (const c of comments.filter((c) => !c.outdated && c.line != null)) {
    // `comment <id>` lets the agent reply in that thread after fixing.
    lines.push(`- [@${c.login} · comment ${c.id}] ${c.path}:${c.line} — ${c.body.replace(/\s+/g, " ").trim().slice(0, 400)}`);
  }
  for (const rv of reviews) {
    // Skip Michael's own short "Michael review · <sha>" boilerplate (the inline
    // comments above already carry its findings).
    if (rv.login === BOT_LOGIN && /^Michael review/.test(rv.body.trim())) continue;
    const state = rv.state ? ` ${rv.state.toLowerCase().replace(/_/g, " ")}` : "";
    lines.push(`- [@${rv.login} review${state}] ${rv.body.replace(/\s+/g, " ").trim().slice(0, 600)}`);
  }
  return lines.join("\n");
}
