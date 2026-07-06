/**
 * Merge/deploy/preview events for PR-linked Backstage sessions. When a PR whose
 * head branch belongs to a session (primary branch or an attached repo) is
 * merged, a `[GitHub]` message is delivered into that session's chat through the
 * SessionControl registry — the same steer/queue/start path a human message
 * takes — so Michael sees it and can react. The merge commit is then tracked in
 * ~/.backstage-github/pending-deploys.json (survives restarts), and when the
 * Deploy workflow (.github/workflows/deploy.yml) completes for that commit the
 * session gets a second message with the outcome. (Pre-merge staging previews
 * are NOT announced here — the session header's Staging button already surfaces
 * the preview URL + Ready state, so a chat notification would just be redundant.)
 */
import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { tryGetSessionControl, type SessionControl, type SessionSummary } from "../../server/session-control";
import { REPOS } from "../../server/worktree";

const HOME = process.env.HOME || "/home/ubuntu";
const PENDING_PATH = `${HOME}/.backstage-github/pending-deploys.json`;
const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy.yml";
/** A merge whose deploy never reported back is dropped after this long. */
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

interface PendingDeploy {
  prNumber: number;
  title: string;
  headRef: string;
  sessionIds: string[];
  recordedAt: string;
}

/** merge_commit_sha → the merge we're waiting on a deploy for. */
type PendingDeploys = Record<string, PendingDeploy>;

function readPending(): PendingDeploys {
  if (!existsSync(PENDING_PATH)) return {};
  try {
    const all = JSON.parse(readFileSync(PENDING_PATH, "utf-8")) as PendingDeploys;
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sha, p] of Object.entries(all)) {
      if (new Date(p.recordedAt).getTime() < cutoff) delete all[sha];
    }
    return all;
  } catch {
    return {};
  }
}

function projectIdForRepo(fullName: string): string | null {
  for (const repo of Object.values(REPOS)) {
    if (repo.ghRepo === fullName) return repo.id;
  }
  return null;
}

/** Live (non-archived) sessions working on `branch` of `projectId`, primary or attached. */
function matchSessions(control: SessionControl, projectId: string, branch: string): SessionSummary[] {
  return control.listSessions().filter((s) => {
    if (s.state === "archived") return false;
    if ((s.repo || "tella-fusion") === projectId && s.branch === branch) return true;
    return (s.attachedRepos || []).some((r) => r.repo === projectId && r.branch === branch);
  });
}

async function deliver(control: SessionControl, sessionIds: string[], message: string): Promise<void> {
  for (const id of sessionIds) {
    try {
      // busy: "queue" — these are FYI events; wait behind an in-flight run
      // rather than steering (interrupt-and-redirect) it like a human message.
      const res = await control.deliverToSession(id, message, "GitHub", { busy: "queue" });
      console.log(`[github] session notify → ${id}: ${res.status}`);
    } catch (e) {
      console.error(`[github] session notify → ${id} failed:`, e);
    }
  }
}

/** `pull_request` webhook payload with action=closed & merged=true. */
export async function notifyMergedPrSessions(payload: any): Promise<void> {
  const pr = payload?.pull_request;
  const headRef: string = pr?.head?.ref || "";
  const projectId = projectIdForRepo(payload?.repository?.full_name || "");
  if (!pr || !headRef || !projectId) return;
  const control = tryGetSessionControl();
  if (!control) return;

  const sessions = matchSessions(control, projectId, headRef);
  if (!sessions.length) return;

  const prNumber: number = pr.number;
  const title: string = pr.title || `PR #${prNumber}`;
  const mergedBy: string = pr.merged_by?.login || payload?.sender?.login || "someone";
  const base: string = pr.base?.ref || "main";
  // Deploy tracking only exists for tella-fusion's deploy.yml (runs on every push
  // to main, one run per merge commit — no cancel-concurrency, so sha match is exact).
  const trackDeploy = projectId === "tella-fusion" && base === "main" && !!pr.merge_commit_sha;

  const message =
    `🔀 This session's PR #${prNumber} “${title}” (branch \`${headRef}\`) was just merged into ${base} by ${mergedBy}.` +
    (trackDeploy
      ? " The Deploy workflow is running for this merge — you'll get another message here when it finishes."
      : "") +
    " This is an FYI event: acknowledge briefly; no action needed unless something depends on it.";

  console.log(`[github] PR #${prNumber} merged → notifying ${sessions.length} session(s) on ${projectId}:${headRef}`);
  await deliver(control, sessions.map((s) => s.id), message);

  if (trackDeploy) {
    const pending = readPending();
    pending[pr.merge_commit_sha] = {
      prNumber,
      title,
      headRef,
      sessionIds: sessions.map((s) => s.id),
      recordedAt: new Date().toISOString(),
    };
    writeJsonAtomic(PENDING_PATH, pending);
  }
}

/** `workflow_run` webhook payload; acts only on Deploy completions we're waiting on. */
export async function handleDeployWorkflowRun(payload: any): Promise<void> {
  if (payload?.action !== "completed") return;
  const run = payload?.workflow_run;
  if (!run || (run.path !== DEPLOY_WORKFLOW_PATH && run.name !== "Deploy")) return;

  const pending = readPending();
  const entry = pending[run.head_sha];
  if (!entry) return;
  delete pending[run.head_sha];
  writeJsonAtomic(PENDING_PATH, pending);

  const control = tryGetSessionControl();
  if (!control) return;

  const success = run.conclusion === "success";
  const message = success
    ? `🚀 Deploy finished for PR #${entry.prNumber} “${entry.title}” — the merge is live in production. This is an FYI event: acknowledge briefly; no action needed.`
    : `❌ Deploy ${run.conclusion || "failed"} for PR #${entry.prNumber} “${entry.title}” — worth a look: ${run.html_url}`;

  console.log(`[github] Deploy ${run.conclusion} for ${run.head_sha} → notifying ${entry.sessionIds.length} session(s)`);
  await deliver(control, entry.sessionIds, message);
}
