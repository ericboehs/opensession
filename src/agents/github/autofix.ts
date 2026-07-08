/**
 * Behavior 2: `michael-auto-fix`. Checks out the PR head branch in a dedicated
 * worktree, fixes its own review findings + failing CI, pushes to the PR branch,
 * polls CI, and re-fixes until green AND a fresh Michael review of the pushed
 * code finds nothing blocking — bounded so it can never run away. The loop is
 * gated on that fresh review rather than the fixer's own self-report, so it can't
 * stop while Michael's review would still flag a P0/P1. Removes the label when it
 * finishes.
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
import { runGithubAgent, authorForLogin, sessionUrl } from "./run";
import { buildAutoFixPrompt } from "./prompts";
import { postIssueComment, editIssueComment, removeLabel, listReviewComments, listReviews, resolveAddressedThreads, BOT_LOGIN } from "./github-rest";
import { LABEL_AUTOFIX } from "./constants";
import type { PrRef, ReviewResult } from "./review";
import { defaultRepo } from "../../server/config";

const MAX_ITERATIONS = 5;
const WALL_CLOCK_MS = 60 * 60 * 1000; // abandon a loop running longer than an hour
const CHECK_POLL_MS = 30 * 1000;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

const REPO = defaultRepo().ghRepo;

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
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number)) {
    console.log(`[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping auto-fix`);
    return;
  }

  const author = authorForLogin(requestedBy);
  let statusCommentId: number | undefined;
  const link = `[📺 open session](${sessionUrl(pr.number, "autofix")})`;

  const updateStatus = async (text: string) => {
    // Keep the session link on the header line; any extra lines (disposition
    // breakdown) render below it rather than getting glued to the link.
    const [head, ...rest] = text.split("\n");
    const tail = rest.length ? `\n${rest.join("\n")}` : "";
    const body = `<!-- michael-autofix -->\n🛠️ **Michael auto-fix** — ${head} · ${link}${tail}`;
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
    // Reuse the status comment only when recovering an interrupted loop; a fresh
    // re-trigger posts a new comment instead of editing the previous run's.
    statusCommentId = resuming ? prior?.statusCommentId : undefined;
    const startedAt = resuming && prior?.startedAt ? prior.startedAt : new Date().toISOString();
    let iterations = resuming ? prior?.iterations || 0 : 0;
    // A killed-and-recovered loop re-enters with no steer arg; pull it back from state.
    const effectiveSteer = steer ?? (resuming ? prior?.steer : undefined);

    const s = getOrInitPrState(pr.number, pr.headRef);
    s.autoFix = { active: true, iterations, startedAt, statusCommentId, requestedBy, worktreeDir: prior?.worktreeDir, lastPushedSha: prior?.lastPushedSha, steer: effectiveSteer };
    writePrState(s);

    // Post the first status BEFORE the (slow) worktree checkout so the PR shows it's working ASAP.
    await updateStatus(resuming ? `resuming (iteration ${iterations + 1}/${MAX_ITERATIONS})…` : `starting (up to ${MAX_ITERATIONS} iterations) — setting up a worktree…`);
    const worktreeDir = await createWorktreeForPrBranch(pr.headRef);

    // Baseline to the CURRENT head so an iteration that pushes nothing compares
    // equal (no false "pushed" / false success on iteration 1).
    const baseSha = prior?.lastPushedSha || (await headSha(pr.headRef));
    let lastPushedSha = baseSha;
    let outcome = "";
    let lastDisp: Dispositions | null = null;

    // Review helpers (dynamic import keeps the module graph acyclic). A fresh
    // review of each pushed SHA is what gates the loop; `lastReviewedSha` lets us
    // skip the post-loop refresh review when the last thing we did was review it.
    const { runReview } = await import("./review");
    const { resolveReviewConfig } = await import("./webhook");
    let lastReviewedSha = "";
    const reviewGate = async (sha: string): Promise<ReviewResult | null> => {
      const fresh = await getPrDetails(pr.headRef);
      const ref: PrRef = { number: pr.number, headRef: pr.headRef, headSha: sha, title: fresh?.title || pr.title };
      const rr = await runReview(ref, resolveReviewConfig().config, onSessionCreated, /*force*/ true).catch((e) => {
        console.error(`[github] auto-fix gating review failed for PR #${pr.number}:`, e);
        return null;
      });
      lastReviewedSha = sha;
      return rr;
    };

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

      const prompt = buildAutoFixPrompt(details, reviewSummary, ciBefore.failing, iterations, effectiveSteer);
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
      lastDisp = parseDispositions(result.text);
      const remaining = remainingFrom(lastDisp);

      const st = getOrInitPrState(pr.number, pr.headRef);
      st.autoFix = { active: true, iterations, startedAt, statusCommentId, requestedBy, worktreeDir, lastPushedSha, steer: effectiveSteer };
      writePrState(st);

      if (result.error) { outcome = `⚠️ Stopped — the fix run errored: ${result.error}`; break; }

      if (!pushedSomething) {
        // Nothing changed this round. The fixer's dispositions (rendered below the
        // outcome) explain what it fixed vs deliberately skipped vs couldn't fix —
        // so a P3-only skip reads as a decision, not an opaque "made no changes".
        if (ciBefore.green && remaining === "none") { outcome = "✅ Nothing left to fix — CI green and all findings addressed."; break; }
        outcome = remaining !== "none"
          ? "☑️ No further changes this round — the remaining items were deliberately skipped or couldn't be auto-fixed:"
          : "☑️ The fixer made no further changes.";
        break;
      }

      const sha7 = lastPushedSha.slice(0, 7);
      await updateStatus(`iteration ${iterations}/${MAX_ITERATIONS}: pushed \`${sha7}\`, waiting for CI…`);
      const ci = await waitForChecks(pr.headRef);

      if (!ci.settled) { outcome = `⏳ Pushed \`${sha7}\` but CI didn't settle within the timeout. Handing back to humans.`; break; }
      if (ci.failing.length) {
        if (iterations >= 2) { outcome = `⚠️ CI still failing after ${iterations} attempts (${ci.failing.join(", ")}). Handing back to humans.`; break; }
        continue; // green CI is a prerequisite for the review gate — fix the checks next round
      }

      // CI is green — gate on a FRESH review of the pushed code, not the fixer's
      // own self-report. Stop only when the review is satisfied — no blocking
      // findings AND either nothing left or confidence >= 4/5 ("safe to merge").
      // A ≤3/5 review with findings still open loops so the next iteration fixes
      // them (P2/P3 included — its inline comments are now the freshest, so
      // fetchReviewFindings picks them up). The loop still terminates naturally when
      // the fixer stops pushing changes, or at the iteration cap.
      await updateStatus(`iteration ${iterations}/${MAX_ITERATIONS}: CI green — reviewing \`${sha7}\`…`);
      const review = await reviewGate(lastPushedSha);

      if (!review || review.error) {
        // No verdict (review lock contention / model error) — fall back to the
        // fixer's self-report so a flaky review can't spin the loop forever.
        if (remaining === "none") { outcome = `✅ Auto-fix complete — CI green, findings addressed (\`${sha7}\`); fresh review verdict unavailable.`; break; }
        outcome = `⚠️ CI green but couldn't get a fresh review verdict and work remains. Handing back to humans.`;
        break;
      }
      const conf = typeof review.confidence === "number" ? review.confidence : null;
      const satisfied = review.blocking === 0 && (review.findings === 0 || (conf != null && conf >= 4));
      if (satisfied) {
        const why = conf != null ? `confidence ${conf}/5` : "no blocking findings";
        outcome = `✅ Auto-fix complete — CI green and the review is satisfied (${why}, \`${sha7}\`).`;
        break;
      }
      const at = conf != null ? `confidence ${conf}/5` : `${review.blocking} blocking`;
      await updateStatus(`iteration ${iterations}/${MAX_ITERATIONS}: review at ${at} with ${review.findings} open finding(s) — continuing to fix…`);
      // loop again to address the remaining findings (not just blockers)
    }

    if (!outcome && iterations >= MAX_ITERATIONS) {
      outcome = `⚠️ Reached the ${MAX_ITERATIONS}-iteration cap. Handing back to humans.`;
    }
    const dispBlock = lastDisp ? formatDispositions(lastDisp) : "";
    await updateStatus(dispBlock ? `${outcome || "done."}\n\n${dispBlock}` : outcome || "done.");

    const fin = getOrInitPrState(pr.number, pr.headRef);
    if (fin.autoFix) { fin.autoFix.active = false; fin.autoFix.iterations = iterations; fin.autoFix.lastPushedSha = lastPushedSha; writePrState(fin); }

    // Refresh the pinned review against the fixed code. The auto-fix push won't
    // trigger a `synchronize` review on its own (it's authored by the bot account,
    // which the webhook guard skips), so the summary would otherwise show stale
    // findings. Skip it when the loop already reviewed this exact SHA via the gate
    // (the common success path) — only break-outs that didn't review need it.
    if (lastPushedSha && lastPushedSha !== baseSha && lastPushedSha !== lastReviewedSha) {
      await reviewGate(lastPushedSha).catch((e) =>
        console.error(`[github] post-autofix review failed for PR #${pr.number}:`, e),
      );
    }

    // Mark the review threads the fixer addressed (left a "Fixed in <sha>" reply on)
    // as resolved, and sweep any of our own now-outdated review threads. Only runs
    // when the fixer actually pushed — a no-op loop resolves nothing.
    if (lastPushedSha && lastPushedSha !== baseSha) {
      const n = await resolveAddressedThreads(pr.number, /*alsoOutdatedBotThreads*/ true).catch((e) => {
        console.error(`[github] resolving addressed threads failed for PR #${pr.number}:`, e);
        return 0;
      });
      if (n) console.log(`[github] resolved ${n} review thread(s) on PR #${pr.number} after auto-fix`);
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

interface Dispositions {
  fixed: string;
  skipped: string;
  unresolved: string;
}

/**
 * Parse the fixer's end-of-turn disposition lines (FIXED / SKIPPED / UNRESOLVED),
 * falling back to the legacy `REMAINING_FINDINGS:` line for older outputs. Empty
 * string for a field means "nothing" (the fixer wrote "none" or omitted it).
 */
function parseDispositions(text: string): Dispositions {
  const grab = (key: string): string => {
    const m = (text || "").match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "im"));
    const v = m ? m[1].trim() : "";
    return /^none\.?$/i.test(v) ? "" : v;
  };
  const d: Dispositions = { fixed: grab("FIXED"), skipped: grab("SKIPPED"), unresolved: grab("UNRESOLVED") };
  if (!d.fixed && !d.skipped && !d.unresolved) {
    const m = (text || "").match(/REMAINING_FINDINGS:\s*(.+)\s*$/im);
    const rem = m ? m[1].trim() : "";
    if (rem && rem.toLowerCase() !== "none") d.unresolved = rem;
  }
  return d;
}

/** "none" when the fixer left nothing open; otherwise a short description of what remains. */
function remainingFrom(d: Dispositions): string {
  const parts = [d.skipped && `skipped: ${d.skipped}`, d.unresolved && `unresolved: ${d.unresolved}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "none";
}

/** Markdown breakdown of what the fixer did this run, for the status comment. */
function formatDispositions(d: Dispositions): string {
  return [
    d.fixed && `**Fixed:** ${d.fixed}`,
    d.skipped && `**Skipped (deliberate):** ${d.skipped}`,
    d.unresolved && `**Couldn't fix:** ${d.unresolved}`,
  ]
    .filter(Boolean)
    .join("\n");
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
