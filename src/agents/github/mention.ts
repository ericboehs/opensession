/**
 * @mention replies. When someone mentions Michael in a PR comment — inline
 * (pull_request_review_comment) or in the conversation (issue_comment) — route it
 * to the PR's mention session and post Michael's reply in-thread.
 *
 * Loop-safe: we skip any comment carrying one of Michael's hidden markers (our own
 * posts), and only act when the body actually mentions a Michael handle — so
 * Michael's replies (which don't mention itself) never re-trigger.
 */
import { getPrDetails } from "../../server/pr-info";
import { listAutomations } from "../../server/automations";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock } from "./state";
import { runGithubAgent, authorForLogin, finalSummary, sessionUrl } from "./run";
import { buildMentionPrompt } from "./prompts";
import {
  postIssueComment,
  editIssueComment,
  replyToReviewComment,
  BOT_LOGIN,
  REPLY_MARKER,
  MICHAEL_MARKERS,
} from "./github-rest";
import { PR_EVENT_KEY } from "./constants";

// Handles that mean "Michael". @michael isn't a real GitHub user (renders as
// plain text) but people type it; tella-butler is the bot's actual handle.
const MENTION_HANDLES = (process.env.GITHUB_MENTION_HANDLES || "michael,tella-butler")
  .split(",")
  .map((h) => h.trim().replace(/^@/, "").toLowerCase())
  .filter(Boolean);
const MENTION_RE = new RegExp(`@(${MENTION_HANDLES.join("|")})\\b`, "i");

function mentionsMichael(body: string): boolean {
  if (!body) return false;
  if (MICHAEL_MARKERS.some((m) => body.includes(m))) return false; // our own content
  return MENTION_RE.test(body);
}

// Bounded in-memory dedup against webhook redelivery.
const handled = new Set<string>();
function alreadyHandled(key: string): boolean {
  if (handled.has(key)) return true;
  handled.add(key);
  if (handled.size > 500) handled.clear();
  return false;
}

export type MentionKind = "issue" | "review";

export async function handleMention(kind: MentionKind, payload: any): Promise<void> {
  if (payload?.action !== "created") return; // ignore edits/deletes
  const comment = payload.comment;
  const body: string = comment?.body || "";
  if (!mentionsMichael(body)) return;

  const authorLogin: string = comment?.user?.login || "";
  if (authorLogin === BOT_LOGIN) return; // the bot's own pushes' account

  let prNumber: number | undefined;
  let inline: { path: string; line?: number; diffHunk?: string } | undefined;
  let replyToId: number | undefined;

  if (kind === "review") {
    prNumber = payload.pull_request?.number;
    inline = {
      path: comment?.path,
      line: comment?.line ?? comment?.original_line,
      diffHunk: comment?.diff_hunk,
    };
    // Reply at the thread root so GitHub threads it correctly.
    replyToId = comment?.in_reply_to_id || comment?.id;
  } else {
    if (!payload.issue?.pull_request) return; // a plain issue, not a PR
    prNumber = payload.issue?.number;
  }
  if (!prNumber || !comment?.id) return;
  if (alreadyHandled(`${kind}:${comment.id}`)) return;

  // Shares the "code" lock with auto-fix/simplify: a mention can push changes, so
  // it must not run concurrently with them on the same PR-branch worktree.
  if (!claimLock("code", prNumber)) {
    console.log(`[github] a code action is already running for PR #${prNumber}, skipping mention`);
    return;
  }
  try {
    const details = await getPrDetails(String(prNumber));
    if (!details) {
      console.warn(`[github] no PR details for #${prNumber}; skipping mention`);
      return;
    }
    if (details.state !== "OPEN") return;
    const headRef = details.headRefName;
    const model = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY)?.model;
    const link = `[📺 open session](${sessionUrl(prNumber, "mention")})`;

    // Progress comment up front (with the session link, so you can open it to
    // monitor) before the slow worktree + agent run.
    const progressId = await postIssueComment(
      prNumber,
      `${REPLY_MARKER}\n🔄 On it — working on @${authorLogin}'s request… · ${link}`,
    );

    // Code mode in the PR-branch worktree so Michael can make + push changes if asked.
    const worktreeDir = await createWorktreeForPrBranch(headRef);

    console.log(`[github] Mention reply on PR #${prNumber} (${kind}) from @${authorLogin}`);
    const result = await runGithubAgent({
      prNumber,
      kind: "mention",
      prompt: buildMentionPrompt({
        prNumber,
        prTitle: details.title,
        headRef,
        author: authorLogin,
        commentBody: body,
        inline,
      }),
      cwd: worktreeDir,
      mode: "code",
      model,
      branch: headRef,
      title: `Mention · PR #${prNumber} ${details.title}`.slice(0, 100),
      resume: true, // keep a conversation across mentions on the same PR
      // Attribute any commits to the person who asked.
      author: authorForLogin(authorLogin),
    });

    const reply = finalSummary(result.text) || "(no reply produced)";
    const out = `${REPLY_MARKER}\n${reply}\n\n<sub>${link}</sub>`;
    if (kind === "review" && replyToId) {
      // Answer in the inline thread; the progress comment becomes a pointer to it.
      const ok = await replyToReviewComment(prNumber, replyToId, out);
      if (!ok) console.warn(`[github] failed to post mention thread reply for PR #${prNumber}`);
      if (progressId) {
        await editIssueComment(progressId, `${REPLY_MARKER}\n✓ Replied in the review thread above. · ${link}`);
      }
    } else {
      // Conversation reply: turn the progress comment into the answer.
      if (progressId) {
        if (!(await editIssueComment(progressId, out))) await postIssueComment(prNumber, out);
      } else {
        await postIssueComment(prNumber, out);
      }
    }
  } catch (e) {
    console.error(`[github] mention reply error for PR #${prNumber}:`, e);
  } finally {
    releaseLock("code", prNumber);
  }
}
