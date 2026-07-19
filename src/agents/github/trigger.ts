/**
 * Shared entry point for triggering the GitHub PR behaviors from a PR number —
 * used by both the Slack @mention intercept (handlers.ts) and the opensession-github
 * MCP tools (slack/github-tools.ts). Resolves the PR, fires the behavior
 * fire-and-forget, and returns a human message to relay.
 */
import { defaultRepo } from "../../server/config";
import { getPrDetails, getPrDiff } from "../../server/pr-info";
import { runReview, type PrRef } from "./review";
import { maybeHandoffFindings } from "./handoff";
import { runAutoFix } from "./autofix";
import { runSimplify } from "./simplify";
import { runAdversarial } from "./adversarial";
import { resolveReviewConfig } from "./webhook";
import { bksIdFor } from "./run";

export type PrActionKind = "review" | "autofix" | "simplify" | "adversarial";

/** Extract a PR number from "4296", "#4296", "pr 4296", or a GitHub PR URL. */
export function parsePrNumber(input: number | string): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.trunc(input) : null;
  const s = String(input);
  const m = s.match(/\/pull\/(\d+)/) || s.match(/#?(\d+)\s*$/) || s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const LABELS: Record<PrActionKind, string> = {
  review: "reviewing",
  autofix: "auto-fixing",
  simplify: "running a simplify pass on",
  adversarial: "running an adversarial review of",
};

export interface TriggerResult {
  ok: boolean;
  message: string;
  url?: string;
  /** Backstage session id for this run (for an Open-in-Backstage link + Stop button). */
  bksId?: string;
  /** Resolves when the behavior finishes — lets the caller update a control card (drop Stop). */
  done?: Promise<unknown>;
}

/**
 * Resolve the PR and start the requested behavior. `requestedBy` is the requester
 * (Slack id or GitHub login) — used for commit attribution on fix/simplify/adversarial.
 * `steer` is the free text of the message that triggered this (PR comment / Slack
 * message), so a mixed-intent request ("…drop the Update.call change. /simplify")
 * carries its specific guidance into the run instead of being reduced to just the
 * verb. Label-triggered paths pass nothing, behaving exactly as before.
 */
export async function triggerPrAction(
  kind: PrActionKind,
  prNumber: number,
  requestedBy: string,
  steer?: string,
  ghRepo?: string,
): Promise<TriggerResult> {
  const details = await getPrDetails(String(prNumber), ghRepo || undefined);
  if (!details) {
    return { ok: false, message: `I couldn't find PR #${prNumber} on ${ghRepo || defaultRepo().ghRepo}.` };
  }
  const diff = await getPrDiff(details.headRefName, ghRepo || undefined);
  const ref: PrRef = {
    number: prNumber,
    headRef: details.headRefName,
    headSha: diff?.headRefOid || "",
    title: details.title,
    ...(ghRepo ? { ghRepo } : {}),
  };

  const fail = (e: unknown) => console.error(`[github] ${kind} trigger failed for PR #${prNumber}:`, e);
  let done: Promise<unknown>;
  switch (kind) {
    case "review":
      // force=true: an explicit request reviews even an already-reviewed SHA.
      // Same handoff tail as webhook.ts's fireReview — this branch also serves
      // the startup recovery of restart-interrupted reviews, and without it an
      // unsatisfied recovered review reached nobody: the verdict posted but the
      // owning session never got its fix round (PR #5055, 2026-07-19). SHA
      // dedup + the round cap inside maybeHandoffFindings keep this safe if a
      // webhook-fired review races the same SHA.
      done = runReview(ref, resolveReviewConfig().config, undefined, true, steer)
        .then((result) => maybeHandoffFindings(ref, result))
        .catch(fail);
      break;
    case "autofix":
      done = runAutoFix(ref, requestedBy, undefined, false, steer).catch(fail);
      break;
    case "simplify":
      done = runSimplify(ref, requestedBy, undefined, steer).catch(fail);
      break;
    case "adversarial":
      done = runAdversarial(ref, requestedBy, undefined, steer).catch(fail);
      break;
  }

  return {
    ok: true,
    url: details.url,
    bksId: bksIdFor(prNumber, kind, ghRepo),
    done,
    message: `${LABELS[kind]} PR #${prNumber} (“${details.title}”). I'll post the results on the PR: ${details.url}`,
  };
}
