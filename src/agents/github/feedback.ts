/**
 * Review feedback store — the learning half of the review bot. One JSON file
 * per repo at ~/.opensession-github/feedback-<key>.json recording every inline
 * finding we post and what happened to it (👍/👎 reactions, addressed vs
 * ignored, missed bugs). Consumers:
 *  - postReview (review.ts): records new findings, harvests outcomes from the
 *    threads it already fetches, and withholds P2/P3 findings that resemble
 *    ≥3 negative-outcome past comments (suppressDecision, feedback-gates.ts).
 *  - the merge handler (webhook.ts): final outcome sweep when a PR closes —
 *    threads still open+current then count as "ignored".
 *  - missed-bugs.ts: records reviewer false negatives.
 * The addressed rate derivable from this store is THE health metric for the
 * reviewer (Greptile's meta-lesson: judge comments by author behavior, never
 * by asking a model to grade itself).
 */
import { stateDir } from "../../server/rename-compat";
import { audit } from "../../server/audit";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { existsSync, readFileSync } from "fs";
import { defaultRepo } from "../../server/config";
import { repoForFullName } from "./constants";
import { BOT_LOGIN, type ReviewThread } from "./github-rest";
import {
  suppressDecision,
  isNegativeSignal,
  isPositiveSignal,
  type FeedbackRecord,
} from "./feedback-gates";

const STATE_DIR = stateDir("github");
const MAX_RECORDS = 600;

function feedbackPath(ghRepo?: string): string {
  const key =
    !ghRepo || ghRepo.toLowerCase() === defaultRepo().ghRepo.toLowerCase()
      ? "default"
      : repoForFullName(ghRepo)?.id || ghRepo.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${STATE_DIR}/feedback-${key}.json`;
}

export function readFeedback(ghRepo?: string): FeedbackRecord[] {
  const path = feedbackPath(ghRepo);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as FeedbackRecord[]) : [];
  } catch {
    return [];
  }
}

function writeFeedback(ghRepo: string | undefined, records: FeedbackRecord[]): void {
  writeJsonAtomic(feedbackPath(ghRepo), records.slice(-MAX_RECORDS));
}

/** Record the inline findings a review just posted. */
export function recordPostedFindings(
  ghRepo: string | undefined,
  prNumber: number,
  findings: Array<{ path: string; severity?: string; title?: string; body: string }>,
): void {
  if (!findings.length) return;
  const records = readFeedback(ghRepo);
  const now = new Date().toISOString();
  for (const f of findings) {
    records.push({
      pr: prNumber,
      path: f.path,
      severity: (f.severity || "").toUpperCase(),
      title: (f.title || "").slice(0, 200),
      text: f.body.replace(/\s+/g, " ").trim().slice(0, 400),
      postedAt: now,
    });
  }
  writeFeedback(ghRepo, records);
}

/** Match a stored record to a bot thread: same PR + path, and the thread's
 *  root comment contains the finding's title (comment ids aren't returned by
 *  the review-submission API, so text matching is the join key). */
function matchRecord(
  records: FeedbackRecord[],
  prNumber: number,
  thread: ReviewThread,
): FeedbackRecord | undefined {
  const rootBody = thread.comments[0]?.body || "";
  return records.find(
    (r) =>
      r.pr === prNumber &&
      r.path === (thread.path || "") &&
      r.title &&
      rootBody.includes(r.title.slice(0, 120)),
  );
}

/**
 * Fold thread state into the store: reactions on the root comment, and
 * outcomes — resolved/outdated means the author acted ("addressed");
 * open + current when the PR is closing means they didn't ("ignored").
 * Cheap: callers pass threads they already fetched.
 */
export function harvestThreadOutcomes(
  ghRepo: string | undefined,
  prNumber: number,
  threads: ReviewThread[],
  prClosed: boolean,
): { addressed: number; ignored: number } {
  const records = readFeedback(ghRepo);
  let addressed = 0;
  let ignored = 0;
  let dirty = false;
  for (const t of threads) {
    if (t.rootAuthor !== BOT_LOGIN) continue;
    const rec = matchRecord(records, prNumber, t);
    if (!rec) continue;
    const root = t.comments[0];
    if (root && (root.plus || root.minus)) {
      if (rec.plus !== root.plus || rec.minus !== root.minus) {
        rec.plus = root.plus;
        rec.minus = root.minus;
        dirty = true;
      }
    }
    if (rec.outcome) continue; // outcomes are terminal — first verdict sticks
    if (t.isResolved || t.isOutdated) {
      rec.outcome = "addressed";
      addressed++;
      dirty = true;
    } else if (prClosed) {
      rec.outcome = "ignored";
      ignored++;
      dirty = true;
    }
  }
  if (dirty) writeFeedback(ghRepo, records);
  if (prClosed && (addressed || ignored)) {
    audit({
      msg: "review_feedback_outcome",
      pr_number: prNumber,
      repo: ghRepo || defaultRepo().ghRepo,
      addressed,
      ignored,
    });
  }
  return { addressed, ignored };
}

/** Should this candidate finding be withheld? Never suppresses P0/P1 — the
 *  filter exists to kill recurring nits, not to gamble with blockers. */
export function shouldSuppressFinding(
  ghRepo: string | undefined,
  finding: { severity?: string; title?: string; body: string },
): boolean {
  const sev = (finding.severity || "").toUpperCase();
  if (sev === "P0" || sev === "P1" || sev === "HIGH") return false;
  const records = readFeedback(ghRepo).filter((r) => !r.falseNegative);
  if (records.length < 10) return false; // not enough history to trust
  return (
    suppressDecision(`${finding.title || ""} ${finding.body}`, records) === "suppress"
  );
}

/** Record a reviewer false negative (missed-bugs.ts). */
export function recordFalseNegative(
  ghRepo: string | undefined,
  culpritPr: number,
  text: string,
): void {
  const records = readFeedback(ghRepo);
  records.push({
    pr: culpritPr,
    path: "",
    severity: "",
    title: "missed bug",
    text: text.slice(0, 400),
    postedAt: new Date().toISOString(),
    falseNegative: true,
  });
  writeFeedback(ghRepo, records);
}

/** Aggregate health numbers (surfaced via the github agent's health()). */
export function feedbackStats(ghRepo?: string): Record<string, number> {
  const records = readFeedback(ghRepo);
  const settled = records.filter((r) => r.outcome);
  return {
    findings: records.filter((r) => !r.falseNegative).length,
    addressed: settled.filter((r) => r.outcome === "addressed").length,
    ignored: settled.filter((r) => r.outcome === "ignored").length,
    upvoted: records.filter((r) => isPositiveSignal(r) && (r.plus || 0) > 0).length,
    downvoted: records.filter((r) => isNegativeSignal(r) && (r.minus || 0) > 0).length,
    missedBugs: records.filter((r) => r.falseNegative).length,
  };
}
