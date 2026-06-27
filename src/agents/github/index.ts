/**
 * GitHub PR agent: automated review + auto-fix + simplify for tellahq/tella-fusion.
 *
 * Does NOT own a webhook route — the single GitHub webhook lives in the Slack agent
 * (`POST /github/webhook`), which forwards `pull_request` events to
 * `handleGithubPrEvent` (webhook.ts). This module owns lifecycle: seeding the
 * disabled review automation, recovering interrupted auto-fix loops on restart,
 * health, and a secret-gated manual trigger for testing.
 */
import type { AgentModule } from "../types";
import {
  listAutomations,
  createAutomation,
  saveAutomation,
} from "../../server/automations";
import { githubConfigured } from "./github-rest";
import { PR_EVENT_KEY, REVIEW_AUTOMATION_NAME } from "./constants";
import { DEFAULT_REVIEW_PROMPT } from "./prompts";
import { setGithubSessionInvalidate, resolveReviewConfig } from "./webhook";
import { listPrStates, activeCodeLoops } from "./state";
import type { PrRef } from "./review";

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

/** Seed the review automation (disabled) if it doesn't exist yet. Keyed on eventKey. */
function ensureReviewAutomation(): void {
  const existing = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  if (existing) return;
  const created = createAutomation({
    name: REVIEW_AUTOMATION_NAME,
    prompt: DEFAULT_REVIEW_PROMPT,
    schedule: "",
    mode: "ask",
    createdBy: "Michael (github agent)",
    eventKey: PR_EVENT_KEY,
    model: "claude-opus-4-8",
  });
  if ("error" in created) {
    console.error(`[github] Failed to seed review automation:`, created.error);
    return;
  }
  // Seed it OFF — start label-only; flip on in the Automations UI to review every non-draft PR.
  saveAutomation({ ...created, enabled: false });
  console.log(`[github] Seeded review automation "${REVIEW_AUTOMATION_NAME}" (disabled)`);
}

/** Re-enter auto-fix loops that a restart interrupted. */
async function recoverFixLoops(): Promise<void> {
  const interrupted = listPrStates().filter((s) => s.autoFix?.active);
  if (!interrupted.length) return;
  const { runAutoFix } = await import("./autofix");
  for (const s of interrupted) {
    console.log(`[github] Recovering interrupted auto-fix loop for PR #${s.prNumber}`);
    const ref: PrRef = { number: s.prNumber, headRef: s.headRef, headSha: "", title: `PR #${s.prNumber}` };
    void runAutoFix(ref, s.autoFix?.requestedBy || "", undefined, /*resuming*/ true).catch((e) =>
      console.error(`[github] auto-fix recovery failed for PR #${s.prNumber}:`, e),
    );
  }
}

/** Re-run one-shot actions (review/simplify/adversarial) that a restart interrupted. */
async function recoverOneShots(): Promise<void> {
  const interrupted = listPrStates().filter((s) => s.activeRun);
  if (!interrupted.length) return;
  const { triggerPrAction } = await import("./trigger");
  for (const s of interrupted) {
    const run = s.activeRun!;
    console.log(`[github] Recovering interrupted ${run.kind} for PR #${s.prNumber}`);
    void triggerPrAction(run.kind, s.prNumber, run.requestedBy).catch((e) =>
      console.error(`[github] ${run.kind} recovery failed for PR #${s.prNumber}:`, e),
    );
  }
}

export class GithubAgent implements AgentModule {
  name = "github";
  private readonly onSessionInvalidate?: () => void;

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

    // Manual trigger for testing: POST /github-pr/<secret> { prNumber, headRef, headSha?, behavior, requestedBy? }
    routes.set("POST /github-pr/*", async (req, url) => {
      const m = url.pathname.match(/^\/github-pr\/([^/]+)$/);
      if (!m || !GITHUB_WEBHOOK_SECRET || m[1] !== GITHUB_WEBHOOK_SECRET) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      const prNumber = Number(body?.prNumber);
      const headRef = String(body?.headRef || "").trim();
      const behavior = String(body?.behavior || "review");
      if (!prNumber || !headRef) return Response.json({ error: "prNumber and headRef required" }, { status: 400 });
      const ref: PrRef = { number: prNumber, headRef, headSha: String(body?.headSha || ""), title: `PR #${prNumber}` };
      const requestedBy = String(body?.requestedBy || "");

      if (behavior === "autofix") {
        const { runAutoFix } = await import("./autofix");
        void runAutoFix(ref, requestedBy, this.onSessionInvalidate);
      } else if (behavior === "simplify") {
        const { runSimplify } = await import("./simplify");
        void runSimplify(ref, requestedBy, this.onSessionInvalidate);
      } else {
        const { runReview } = await import("./review");
        void runReview(ref, resolveReviewConfig().config, this.onSessionInvalidate);
      }
      return Response.json({ ok: true, behavior, prNumber });
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (!githubConfigured()) {
      console.warn("[github] GITHUB_API_TOKEN unset — review/fix/simplify can't post; agent idle");
    }
    if (!GITHUB_WEBHOOK_SECRET) {
      console.warn("[github] GITHUB_WEBHOOK_SECRET unset — PR webhooks won't be verified/forwarded");
    }
    if (this.onSessionInvalidate) setGithubSessionInvalidate(this.onSessionInvalidate);
    ensureReviewAutomation();
    await recoverFixLoops();
    await recoverOneShots();
    const { autoEnabled } = resolveReviewConfig();
    console.log(`[github] Agent started — review automation ${autoEnabled ? "ENABLED (all non-draft PRs)" : "disabled (label-only)"}`);
  }

  async shutdown(): Promise<void> {
    // Auto-fix loop state is persisted to disk after each iteration; nothing to flush.
  }

  health(): Record<string, unknown> {
    const { autoEnabled } = resolveReviewConfig();
    return {
      status: githubConfigured() ? "operational" : "missing GITHUB_API_TOKEN",
      reviewAutomationEnabled: autoEnabled,
      trackedPrs: listPrStates().length,
      activeCodeLoops: activeCodeLoops(),
    };
  }
}
