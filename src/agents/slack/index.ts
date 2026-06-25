/**
 * Slack Agent Module — handles Slack DMs, @mentions, GitHub PR reviews,
 * worktree channel management, and Block Kit interactions.
 *
 * Implements the AgentModule interface for the backstage webhook server.
 */

import { mkdirSync, existsSync, unlinkSync } from "fs";
import type { AgentModule } from "../types";
import {
  verifySlackSignature,
  verifyGitHubSignature,
} from "../../server/shared/signature";
import { handleMessageEvent, handleMentionEvent } from "./handlers";
import {
  handlePullRequestReview,
  inviteRelevantUsersToChannel,
} from "./github-reviews";
import {
  worktreeChannels,
  branchToChannel,
  branchToChannelName,
  loadWorktreeChannels,
  saveWorktreeChannels,
  createSlackChannel,
  archiveSlackChannel,
  setChannelTopic,
  inviteBotToChannel,
  cleanupWorktrees,
  getWorktreeDirForChannel,
} from "./worktree-channels";
import { loadQueueFromDisk, sessionQueues } from "./queue";
import {
  enqueueMessage,
  getOrCreateQueue,
} from "./queue";
import { cancelSession } from "./cancel";
import { cancelAgentRun } from "../../server/agent-runner";
import {
  slackApiCall,
  sendSlackMessage,
  updateSlackBlocks,
  openSlackModal,
} from "./slack-api";
import {
  SESSION_DIR,
  GITHUB_REPO,
  activeSessions,
  processedEvents,
  pendingAnswers,
  slackTeamId,
  slackBotUserId,
  githubWebhooksReceived,
  setSlackTeamId,
  setSlackBotUserId,
  incrementGithubWebhooks,
  loadActiveSessionsOnStartup,
} from "./state";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";

// Cleanup interval handle
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let cleanupTimeout: ReturnType<typeof setTimeout> | null = null;

export class SlackAgent implements AgentModule {
  name = "slack";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // ----- POST /slack/events -----
    routes.set("POST /slack/events", async (req) => {
      // Acknowledge Slack retries immediately — we already have the event
      const retryNum = req.headers.get("x-slack-retry-num");
      if (retryNum) {
        console.log(
          `[slack] Slack retry #${retryNum} (reason: ${req.headers.get("x-slack-retry-reason")}), acking`
        );
        return Response.json({ ok: true });
      }

      const body = await req.text();
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      const payload = JSON.parse(body);

      // URL verification challenge
      if (payload.type === "url_verification") {
        console.log("[slack] URL verification challenge received");
        return Response.json({ challenge: payload.challenge });
      }

      // Event callback
      if (payload.type === "event_callback") {
        const event = payload.event;

        if (event.bot_id || event.subtype === "bot_message") {
          return Response.json({ ok: true });
        }

        // Handle message.im events (DMs)
        if (event.type === "message" && event.channel_type === "im") {
          const eventId = `${event.channel}-${event.ts}`;
          if (processedEvents.has(eventId)) {
            console.log(`[slack] Duplicate event: ${eventId}`);
            return Response.json({ ok: true });
          }
          processedEvents.add(eventId);
          setTimeout(() => processedEvents.delete(eventId), 5 * 60 * 1000);

          handleMessageEvent(event).catch((e) => {
            console.error("[slack] Error handling message:", e);
          });
        }

        // Handle app_mention events
        if (event.type === "app_mention") {
          const eventId = `${event.channel}-${event.ts}`;
          if (processedEvents.has(eventId)) {
            console.log(`[slack] Duplicate mention event: ${eventId}`);
            return Response.json({ ok: true });
          }
          processedEvents.add(eventId);
          setTimeout(() => processedEvents.delete(eventId), 5 * 60 * 1000);

          handleMentionEvent(event).catch((e) => {
            console.error("[slack] Error handling mention:", e);
          });
        }

        // Handle assistant_thread_started events (DM thread opened)
        if (event.type === "assistant_thread_started") {
          const thread = event.assistant_thread;
          if (thread?.channel_id && thread?.thread_ts) {
            slackApiCall("assistant.threads.setSuggestedPrompts", {
              channel_id: thread.channel_id,
              thread_ts: thread.thread_ts,
              prompts: [
                {
                  title: "Check worktrees",
                  message: "What worktrees are currently active?",
                },
                {
                  title: "Health check",
                  message: "Run a health check on all services",
                },
              ],
            }).catch((e: any) => {
              console.warn("[slack] Error setting suggested prompts:", e);
            });
          }
        }
      }

      return Response.json({ ok: true });
    });

    // ----- POST /slack/actions (Block Kit interactions) -----
    routes.set("POST /slack/actions", async (req) => {
      const body = await req.text();
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack action signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      // Parse URL-encoded body
      const params = new URLSearchParams(body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return Response.json({ error: "No payload" }, { status: 400 });
      }

      const payload = JSON.parse(payloadStr);

      // Handle block_actions (button clicks)
      if (payload.type === "block_actions") {
        const action = payload.actions?.[0];
        if (!action) {
          return new Response("", { status: 200 });
        }

        const actionId: string = action.action_id;

        // Check if this is an "Other..." button — must open modal BEFORE returning
        if (actionId.endsWith("-other")) {
          // Extract questionId: "askq-{questionId}-other"
          const match = actionId.match(/^askq-(.+)-other$/);
          if (match?.[1]) {
            const questionId = match[1];
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              const triggerId = payload.trigger_id;
              if (triggerId) {
                const modalResult = await openSlackModal(
                  triggerId,
                  questionId,
                  pending.questionText
                );
                if (!modalResult?.ok) {
                  console.error("[slack] Failed to open modal:", modalResult);
                }
              }
            }
          }
          return new Response("", { status: 200 });
        }

        // Regular option button — handle in background
        const optMatch = actionId.match(/^askq-(.+)-opt-(\d+)$/);
        if (optMatch?.[1]) {
          const questionId = optMatch[1];
          const selectedLabel = action.value;

          // Respond immediately, resolve in background
          setImmediate(() => {
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingAnswers.delete(questionId);
              pending.resolve(selectedLabel);
            }
          });
          return new Response("", { status: 200 });
        }

        // Stop button on a Grafana-poller investigation card — cancel the
        // automation-run session by its backstage id (registered in activeRuns
        // under the bks id, so cancelAgentRun reaches it). `investigate-stop:`
        // is the current prefix; `export-stop:`/`upload-stop:` are kept for any
        // cards posted before the generic poller landed.
        const stopPrefix = ["investigate-stop:", "export-stop:", "upload-stop:"].find((p) =>
          actionId.startsWith(p)
        );
        if (stopPrefix) {
          const bksId = actionId.slice(stopPrefix.length);
          const didCancel = cancelAgentRun(bksId);

          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const label = didCancel ? "Stopped" : "Nothing to stop";
            const keptBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            keptBlocks.push({
              type: "context",
              elements: [{ type: "mrkdwn", text: `_${label}_` }],
            });
            await updateSlackBlocks(msgChannel, msgTs, label, keptBlocks);
          }
          return new Response("", { status: 200 });
        }

        // Stop button — cancel the running session
        if (actionId.startsWith("stop:")) {
          const sessionKey = actionId.slice("stop:".length);
          const didCancel = cancelSession(sessionKey);

          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const label = didCancel ? "Cancelled" : "Nothing to cancel";
            await updateSlackBlocks(msgChannel, msgTs, label, [
              {
                type: "context",
                elements: [{ type: "mrkdwn", text: `_${label}_` }],
              },
            ]);
          }
          return new Response("", { status: 200 });
        }

        // GitHub PR review — "Address this feedback" button
        if (actionId.startsWith("gh-review-address-")) {
          const reviewData = JSON.parse(action.value);
          const {
            branch,
            channelId: reviewChannelId,
            prNumber,
            prUrl,
            reviewerName,
            reviewState,
            reviewBody,
            inlineCommentCount,
          } = reviewData;

          // Update message to remove buttons and show status
          const msgChannel = payload.channel?.id || reviewChannelId;
          const msgTs = payload.message?.ts;
          if (msgTs) {
            const updatedBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            updatedBlocks.push({
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "\u23f3 _Addressing this feedback..._",
                },
              ],
            });
            await updateSlackBlocks(
              msgChannel,
              msgTs,
              "Addressing PR review feedback...",
              updatedBlocks
            );
          }

          // Enqueue prompt to the worktree's Claude session
          const sessionKey = reviewChannelId;
          const worktreeDir = getWorktreeDirForChannel(reviewChannelId);
          const worktreeBranch = worktreeChannels.get(reviewChannelId);

          const prompt = `A PR review was submitted on PR #${prNumber} (${prUrl}) by ${reviewerName}.

Review type: ${reviewState}
${reviewBody ? `Review comment: "${reviewBody}"` : "No overall review comment."}
${inlineCommentCount > 0 ? `There are ${inlineCommentCount} inline comments on specific files.` : ""}

Please address this feedback:
1. Read the PR review comments by running: gh api repos/tellahq/tella-fusion/pulls/${prNumber}/reviews --jq '.[-1]' and gh api repos/tellahq/tella-fusion/pulls/${prNumber}/comments
2. Understand each piece of feedback
3. Make the necessary code changes to address the review
4. Commit and push the changes (ALWAYS push \u2014 never leave changes unpushed)
5. Respond to each individual review comment on the PR by posting replies via: gh api repos/tellahq/tella-fusion/pulls/${prNumber}/comments/{comment_id}/replies -f body="<your response>"
6. Summarize what you changed in response to the review`;

          enqueueMessage(sessionKey, {
            prompt,
            channel: reviewChannelId,
            threadTs: msgTs || "",
            messageTs: msgTs || "",
            userName: "GitHub PR Review",
            userId: slackBotUserId,
            isNewSession: false,
            worktreeDir: worktreeDir || undefined,
            branch: worktreeBranch || undefined,
          });

          return new Response("", { status: 200 });
        }

        // GitHub PR review — "Dismiss" button
        if (actionId.startsWith("gh-review-dismiss-")) {
          const msgChannel = payload.channel?.id;
          const msgTs = payload.message?.ts;
          if (msgTs && msgChannel) {
            const updatedBlocks = (payload.message?.blocks || []).filter(
              (b: any) => b.type !== "actions"
            );
            updatedBlocks.push({
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "\ud83d\udeab _Dismissed_",
                },
              ],
            });
            await updateSlackBlocks(
              msgChannel,
              msgTs,
              "PR review feedback dismissed",
              updatedBlocks
            );
          }
          return new Response("", { status: 200 });
        }

        return new Response("", { status: 200 });
      }

      // Handle view_submission (modal submit for "Other...")
      if (payload.type === "view_submission") {
        const callbackId: string = payload.view?.callback_id || "";
        const match = callbackId.match(/^askq-modal-(.+)$/);

        if (match?.[1]) {
          const questionId = match[1];
          const values = payload.view?.state?.values;
          const answerValue: string =
            values?.answer_block?.answer_input?.value || "";

          setImmediate(() => {
            const pending = pendingAnswers.get(questionId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pendingAnswers.delete(questionId);
              pending.resolve(answerValue);
            }
          });
        }

        // Must return 200 with empty body to close the modal
        return new Response("", { status: 200 });
      }

      return new Response("", { status: 200 });
    });

    // ----- POST /github/webhook -----
    routes.set("POST /github/webhook", async (req) => {
      const body = await req.text();
      const signature = req.headers.get("x-hub-signature-256") || "";

      if (!verifyGitHubSignature(body, signature, GITHUB_WEBHOOK_SECRET)) {
        console.error("[slack] Invalid GitHub webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      incrementGithubWebhooks();
      const event = req.headers.get("x-github-event") || "";
      const payload = JSON.parse(body);

      console.log(
        `[slack] GitHub webhook: event=${event}, action=${payload.action}`
      );

      if (event === "pull_request_review") {
        // Handle async — GitHub has a 10s timeout
        handlePullRequestReview(payload, branchToChannel).catch((e) => {
          console.error("[slack] Error handling PR review webhook:", e);
        });
      }

      return Response.json({ ok: true });
    });

    // ----- POST /worktree/create-channel -----
    routes.set("POST /worktree/create-channel", async (req) => {
      try {
        const body = (await req.json()) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json(
            { error: "branch required" },
            { status: 400 }
          );
        }

        // Check if channel already exists for this branch
        if (branchToChannel.has(branch)) {
          return Response.json({
            ok: true,
            channelId: branchToChannel.get(branch),
            existing: true,
          });
        }

        const channelName = branchToChannelName(branch);
        console.log(
          `[slack] Creating Slack channel: #${channelName} for branch: ${branch}`
        );

        const result = await createSlackChannel(channelName);
        if (!result.ok || !result.channelId) {
          console.error(
            `[slack] Failed to create channel #${channelName}:`,
            result.error
          );
          return Response.json(
            { ok: false, error: result.error },
            { status: 500 }
          );
        }

        const channelId = result.channelId;

        // Invite bot to channel
        await inviteBotToChannel(channelId);

        // Set topic
        const worktreeDir = `/home/ubuntu/worktrees/tella-fusion-${branch}`;
        const ghCompareUrl = `https://github.com/${GITHUB_REPO}/compare/main...${encodeURIComponent(branch)}`;
        await setChannelTopic(
          channelId,
          `${ghCompareUrl} | Mention @michael to interact`
        );

        // Post intro message
        const authResp = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        const botId = ((await authResp.json()) as any).user_id;
        await sendSlackMessage(
          channelId,
          `\ud83d\udc4b This channel is linked to worktree \`${branch}\`.\n\nMention <@${botId}> to interact with Claude working in this worktree.\n\nWorking directory: \`${worktreeDir}\``
        );

        // Save mapping
        worktreeChannels.set(channelId, branch);
        branchToChannel.set(branch, channelId);
        await saveWorktreeChannels();

        console.log(
          `[slack] Created and linked #${channelName} (${channelId}) -> ${branch}`
        );

        // Auto-invite relevant GitHub users (async, don't block response)
        inviteRelevantUsersToChannel(channelId, branch).catch((e) => {
          console.warn("[slack] Error auto-inviting users:", e);
        });

        return Response.json({ ok: true, channelId, channelName });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/create-channel:", e);
        return Response.json(
          { ok: false, error: e.message },
          { status: 500 }
        );
      }
    });

    // ----- POST /worktree/archive-channel -----
    routes.set("POST /worktree/archive-channel", async (req) => {
      try {
        const body = (await req.json()) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json(
            { error: "branch required" },
            { status: 400 }
          );
        }

        const channelId = branchToChannel.get(branch);
        if (!channelId) {
          return Response.json({
            ok: true,
            message: "no channel for this branch",
          });
        }

        console.log(
          `[slack] Archiving Slack channel for branch: ${branch} (${channelId})`
        );

        // Post farewell message
        await sendSlackMessage(
          channelId,
          `\ud83d\uddc2\ufe0f Worktree \`${branch}\` is being deleted. Archiving this channel.`
        );

        // Archive the channel
        await archiveSlackChannel(channelId);

        // Clean up mappings
        worktreeChannels.delete(channelId);
        branchToChannel.delete(branch);
        await saveWorktreeChannels();

        // Clean up any sessions for this channel
        const sessionKey = channelId;
        const session = activeSessions.get(sessionKey);
        if (session) {
          activeSessions.delete(sessionKey);
          try {
            unlinkSync(`${SESSION_DIR}/${sessionKey}.json`);
          } catch {}
        }

        console.log(
          `[slack] Archived channel and cleaned up for branch: ${branch}`
        );

        return Response.json({ ok: true });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/archive-channel:", e);
        return Response.json(
          { ok: false, error: e.message },
          { status: 500 }
        );
      }
    });

    return routes;
  }

  async startup(): Promise<void> {
    // Ensure session directory exists
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true });
    }

    await loadActiveSessionsOnStartup();
    await loadWorktreeChannels();
    await loadQueueFromDisk();

    // Fetch team ID and bot user ID for streaming APIs
    try {
      const authResp = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const authData = (await authResp.json()) as any;
      if (authData.ok) {
        setSlackTeamId(authData.team_id);
        setSlackBotUserId(authData.user_id);
        console.log(
          `[slack] Slack team: ${authData.team} (${authData.team_id}), bot: ${authData.user_id}`
        );
      } else {
        console.warn("[slack] auth.test failed:", authData.error);
      }
    } catch (e) {
      console.warn("[slack] Failed to fetch Slack team info:", e);
    }

    // Run cleanup every 6 hours, and once on startup (after 60s delay)
    cleanupTimeout = setTimeout(cleanupWorktrees, 60_000);
    cleanupInterval = setInterval(cleanupWorktrees, 6 * 60 * 60 * 1000);

    console.log("[slack] Agent started");
  }

  async shutdown(): Promise<void> {
    // Abort all running queries
    for (const [key, sq] of sessionQueues) {
      if (sq.abortController) {
        sq.abortController.abort();
      }
    }

    // Clear cleanup timers
    if (cleanupTimeout) clearTimeout(cleanupTimeout);
    if (cleanupInterval) clearInterval(cleanupInterval);

    console.log("[slack] Agent shut down");
  }

  health(): Record<string, unknown> {
    const queueDetails: Record<
      string,
      { queueLength: number; processing: boolean }
    > = {};
    for (const [key, sq] of sessionQueues) {
      queueDetails[key] = {
        queueLength: sq.queue.length,
        processing: sq.processing,
      };
    }

    return {
      status: "operational",
      agent: "Michael (Slack)",
      activeSessions: activeSessions.size,
      activeQueues: sessionQueues.size,
      pendingQuestions: pendingAnswers.size,
      githubWebhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
      githubApiTokenConfigured: !!process.env.GITHUB_API_TOKEN,
      githubWebhooksReceived,
      queueDetails,
    };
  }
}
