/**
 * Stale-PR monitor — a weekly digest (no PRs, no closing) that surfaces the open-PR
 * backlog on tellahq/tella-fusion so reviewers can act on it. Observe-and-notify only:
 * it reads PRs via `gh` and posts ONE digest to Slack. Distinct from the sweep loops
 * (which open PRs) and the host-health monitor (which checks the VPS).
 *
 * Seeded create-if-absent on startup so UI edits (schedule/channel/prompt) are kept.
 */
import { personaName } from "../../server/config";
import { listAutomations, createAutomation } from "../../server/automations";
import { defaultRepo } from "../../server/config";

const REPO = defaultRepo().ghRepo;
// #engineering — repointable via the Automations UI.
const ALARM_CHANNEL = "C047JD2KX8B";
const EVENT_KEY = "monitor:stale-prs";

const PROMPT = `You are Michael, running the weekly stale-PR digest for ${REPO}. This is OBSERVE-ONLY: you read the open-PR backlog and post ONE Slack digest so reviewers can act. Do NOT open, edit, close, or comment on any PR.

Permissions note: this is read-only with respect to the codebase/git — but posting your digest to Slack via the MCP is the point of this run and is fully allowed; don't refuse on "read-only" grounds.

## 1. Pull the open PRs
\`gh pr list --repo ${REPO} --state open --json number,title,author,createdAt,isDraft,labels --limit 500\`
(Avoid putting \`reviewRequests\` in --json — it can corrupt gh's output. If you need reviewer/CI detail, fetch it only for the handful of PRs you actually list, via \`gh pr view <n>\` / \`gh pr checks <n>\`.)

## 2. Summarize the backlog
- Total open PRs, and split human vs bot (author \`tella-butler\` = bot) and drafts.
- Bucket non-draft PRs by age (days since createdAt): >180d, 90-180d, 30-90d, 14-30d, <14d — give counts per bucket.
- Per-author counts for the worst offenders (top ~5 authors by open-PR count).

## 3. Spotlight the worst
List the ~15 OLDEST non-draft PRs: \`#<n> — <title> · <author> · <age>d\` with the URL. For just these ~15, check CI with \`gh pr checks <n>\` and flag any that are RED. Keep titles short.

## 4. Post ONE digest to Slack
Channel \`${ALARM_CHANNEL}\` via the Slack MCP \`conversations_add_message\`. Start with "🧹 Michael — weekly open-PR backlog (${REPO})". Lead with the headline counts (total / >30d / >180d / no-CI-green), then the per-bucket + per-author summary, then the oldest-15 spotlight. Keep it scannable on a phone. Say it's you, Michael. This digest is intentional and weekly — always post it (no anti-spam suppression), even if the backlog is unchanged.`;

/** Seed the stale-PR monitor (create-if-absent; preserves UI edits). */
export function ensureStalePrMonitor(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: "Stale PR Monitor",
    prompt: PROMPT,
    schedule: "0 16 * * 1", // Mondays ~9am PT (server is UTC)
    mode: "ask", // read-only: no worktree, just gh reads + a Slack post
    createdBy: `${personaName()} (loops)`,
    eventKey: EVENT_KEY,
    mcpServers: ["slack"],
    model: "claude-sonnet-4-6",
  });
  if ("error" in created) {
    console.error(`[loops] Failed to seed Stale PR Monitor:`, created.error);
  } else {
    console.log(`[loops] Seeded monitor "Stale PR Monitor" (${created.id})`);
  }
}
