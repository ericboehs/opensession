/**
 * "Your PR now conflicts" as a system event, delivered to the one session that
 * owns the PR.
 *
 * GitHub has no webhook for this. The `pull_request` action list has nothing
 * for a mergeability change; the `mergeable` field in a delivery is computed
 * lazily, so it arrives null or stale; and the usual cause of a conflict is
 * SOMEONE ELSE's PR landing on the base branch, which fires no event carrying
 * the affected PR's number at all. So the event is synthesized here, off the
 * 60s bulk sweep (pr-cache.ts) that already tracks `mergeable` per PR. No new
 * GitHub subscription and no extra API calls.
 *
 * The transition that matters is MERGEABLE → CONFLICTING. Two properties of the
 * tracking are deliberate:
 *  - UNKNOWN is ignored rather than recorded. GitHub reports it whenever the
 *    background merge test hasn't finished, so a flicker through UNKNOWN must
 *    not hide a real transition or manufacture a fake one.
 *  - Last-known state is in memory only, and a PR first seen as CONFLICTING
 *    never fires. That is what makes a restart quiet: PRs already conflicted
 *    before boot are adopted silently instead of waking every session at once.
 *
 * Delivery goes to exactly ONE session, and only tells it what happened. The
 * session decides when (and whether) to resolve. Nothing here touches git.
 */
import type { PrInfo } from "../../server/pr-cache";

export interface PrConflictEvent {
  repoId: string;
  branch: string;
  number: number;
  title: string;
  url: string;
  /** Session id from the PR body's attribution footer, when it carried one. */
  sessionRef?: string;
}

/** `repoId#number` → last non-UNKNOWN mergeability the sweep reported. */
const lastKnown = new Map<string, string>();

function prKeyOf(repoId: string, number: number): string {
  return `${repoId}#${number}`;
}

/** Test seam: forget every remembered state. */
export function resetConflictWatch(): void {
  lastKnown.clear();
}

/**
 * Fold one sweep's PR snapshot into the remembered state and return the PRs
 * that just went from mergeable to conflicting. Only `freshRepos` are read:
 * the sweep carries other repos' maps forward untouched, and a repo whose
 * open-PR query failed must not be compared against.
 */
export function scanConflictTransitions(
  data: Map<string, Map<string, PrInfo>>,
  freshRepos: Set<string>,
): PrConflictEvent[] {
  const events: PrConflictEvent[] = [];
  const seen = new Set<string>();
  for (const repoId of freshRepos) {
    for (const [branch, pr] of data.get(repoId) || []) {
      if (pr.state !== "OPEN") continue;
      const key = prKeyOf(repoId, pr.number);
      seen.add(key);
      if (pr.mergeable !== "MERGEABLE" && pr.mergeable !== "CONFLICTING") continue;
      const prev = lastKnown.get(key);
      lastKnown.set(key, pr.mergeable);
      if (prev === "MERGEABLE" && pr.mergeable === "CONFLICTING") {
        events.push({
          repoId,
          branch,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          ...(pr.sessionRef ? { sessionRef: pr.sessionRef } : {}),
        });
      }
    }
  }
  // Forget PRs this sweep no longer reports as open, so a reopened branch
  // starts clean rather than firing off a months-old remembered state.
  for (const key of [...lastKnown.keys()]) {
    const repoId = key.slice(0, key.lastIndexOf("#"));
    if (freshRepos.has(repoId) && !seen.has(key)) lastKnown.delete(key);
  }
  return events;
}

/**
 * What the session is told: the fact, and nothing else. It is a notification,
 * so it does not prescribe a resolution procedure, rank the work against
 * whatever the session is already doing, or repeat the git rules the agent
 * already has. When and how to fix it is the session's call.
 */
export function conflictMessage(event: PrConflictEvent): string {
  return `PR #${event.number} “${event.title}” now has merge conflicts with its base branch. ${event.url}`;
}

/**
 * Deliver the event to the session that owns the PR. Ownership is the session
 * whose id the PR body's attribution footer carries (the session that opened
 * it); a PR opened by hand falls back to the newest live session working on its
 * head branch. Never fans out: an unowned PR is simply not announced.
 */
export async function notifyConflictedPrSession(event: PrConflictEvent): Promise<void> {
  const { tryGetSessionControl } = await import("../../server/session-control");
  const control = tryGetSessionControl();
  if (!control) return;

  let target = event.sessionRef ? control.getSession(event.sessionRef) : undefined;
  if (target?.state === "archived") target = undefined;
  if (!target) {
    const { matchSessions } = await import("./session-notify");
    target = [...matchSessions(control, event.repoId, event.branch)].sort(
      (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
    )[0];
  }
  if (!target) return;

  const { audit } = await import("../../server/audit");
  try {
    // Steer by default: a non-interrupting fold the running turn picks up at
    // its next stopping point, and a fresh turn when the session is idle.
    const res = await control.deliverToSession(target.id, conflictMessage(event), "GitHub");
    console.log(
      `[github] PR #${event.number} now conflicting → ${target.id}: ${res.status}`,
    );
    audit({
      msg: "github_pr_conflict_notified",
      pr_number: event.number,
      repo_id: event.repoId,
      head_ref: event.branch,
      session_id: target.id,
      matched_by: event.sessionRef === target.id ? "pr_footer" : "head_branch",
      delivery: res.status,
    });
  } catch (e) {
    console.error(`[github] conflict notify → ${target.id} failed:`, e);
  }
}
