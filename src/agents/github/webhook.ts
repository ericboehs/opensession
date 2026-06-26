/**
 * Dispatch target for GitHub PR webhooks. The single GitHub webhook is owned by
 * the Slack agent (`POST /github/webhook`), which forwards `pull_request` events
 * here. This routes them to the review / auto-fix / simplify behaviors.
 *
 * Defensive: never throws into the Slack handler; all behaviors are fired
 * fire-and-forget (GitHub's 10s webhook timeout).
 */
import { listAutomations } from "../../server/automations";
import { GITHUB_REPO, BOT_LOGIN } from "./github-rest";
import {
  PR_EVENT_KEY,
  REVIEW_AUTOMATION_NAME,
  LABEL_REVIEW,
  LABEL_AUTOFIX,
  LABEL_SIMPLIFY,
} from "./constants";
import { runReview, type PrRef, type ReviewConfig } from "./review";
import { DEFAULT_REVIEW_PROMPT } from "./prompts";

let onSessionInvalidate: (() => void) | undefined;
export function setGithubSessionInvalidate(cb: () => void): void {
  onSessionInvalidate = cb;
}

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

interface PrPayload {
  number: number;
  draft?: boolean;
  state?: string;
  title?: string;
  head?: { ref?: string; sha?: string };
  user?: { login?: string };
  labels?: Array<{ name: string }>;
}

function prRef(pr: PrPayload): PrRef | null {
  if (!pr || typeof pr.number !== "number" || !pr.head?.ref) return null;
  return {
    number: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha || "",
    title: pr.title || `PR #${pr.number}`,
  };
}

/** Resolve review config from the seeded automation (its enabled flag + prompt/model). */
export function resolveReviewConfig(): { autoEnabled: boolean; config: ReviewConfig } {
  const automation = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  return {
    autoEnabled: !!automation?.enabled,
    config: {
      prompt: automation?.prompt || DEFAULT_REVIEW_PROMPT,
      model: automation?.model,
    },
  };
}

export async function handleGithubPrEvent(event: string, payload: any): Promise<void> {
  try {
    if (payload?.repository?.full_name && payload.repository.full_name !== GITHUB_REPO) return;
    // Ignore our own actions to avoid self-trigger loops.
    if (payload?.sender?.login && payload.sender.login === BOT_LOGIN) return;
    if (event !== "pull_request") return;

    const pr = payload.pull_request as PrPayload;
    const ref = prRef(pr);
    if (!ref) return;
    const action: string = payload.action || "";

    // ── Label actions ──
    if (action === "labeled") {
      const label: string = payload.label?.name || "";
      const requestedBy: string = payload.sender?.login || "";
      if (label === LABEL_REVIEW) {
        void fireReview(ref, true);
      } else if (label === LABEL_AUTOFIX) {
        void fireAutoFix(ref, requestedBy);
      } else if (label === LABEL_SIMPLIFY) {
        void fireSimplify(ref, requestedBy);
      }
      return;
    }

    // ── Open / update actions → review when opted in and non-draft ──
    if (REVIEW_ACTIONS.has(action)) {
      if (pr.draft) return; // skip drafts until ready_for_review
      const labeled = (pr.labels || []).some((l) => l.name === LABEL_REVIEW);
      const { autoEnabled } = resolveReviewConfig();
      if (labeled || autoEnabled) void fireReview(ref, false);
    }
  } catch (e) {
    console.error("[github] handleGithubPrEvent error:", e);
  }
}

async function fireReview(ref: PrRef, _byLabel: boolean): Promise<void> {
  const { config } = resolveReviewConfig();
  await runReview(ref, config, onSessionInvalidate).catch((e) =>
    console.error(`[github] runReview failed for PR #${ref.number}:`, e),
  );
}

async function fireAutoFix(ref: PrRef, requestedBy: string): Promise<void> {
  const { runAutoFix } = await import("./autofix");
  await runAutoFix(ref, requestedBy, onSessionInvalidate).catch((e) =>
    console.error(`[github] runAutoFix failed for PR #${ref.number}:`, e),
  );
}

async function fireSimplify(ref: PrRef, requestedBy: string): Promise<void> {
  const { runSimplify } = await import("./simplify");
  await runSimplify(ref, requestedBy, onSessionInvalidate).catch((e) =>
    console.error(`[github] runSimplify failed for PR #${ref.number}:`, e),
  );
}
