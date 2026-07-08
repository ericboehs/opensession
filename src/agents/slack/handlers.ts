/**
 * Core event handlers for the Slack agent.
 *
 * handleMessageEvent  — DM messages
 * handleMentionEvent  — @mention in channels
 * processMessage      — runs the Claude Agent SDK query() for a queued message
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKResultMessage,
  PermissionResult,
  PostToolUseHookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { markdownToSlack } from "../../server/shared/markdown";
import { cleanPlainToolInput } from "../../server/shared/note-style";
import { SLACK_SYSTEM_PROMPT_APPEND } from "./prompts";
import {
  sendSlackMessage,
  addReaction,
  removeReaction,
  getUserInfo,
  fetchThreadContext,
  postSlackBlocks,
  updateSlackBlocks,
  openSlackModal,
  slackApiCall,
  getChannelKind,
  MESSAGES,
} from "./slack-api";
import { SlackStreamer, buildToolStatus, isSilentTool } from "./streamer";
import { SlackProgress } from "./progress";
import { createAdminMcpServer } from "./admin-tools";
import { createGithubMcpServer } from "./github-tools";
import { createSessionsMcpServer } from "./sessions-tools";
import { createHumansMcpServer } from "./humans-tools";
import { matchReply as matchHumanAskReply } from "../../server/human-asks";
import { triggerPrAction } from "../github/trigger";
import { classifyMention } from "./mention-intent";
import { renderMemoryForPrompt, type MemoryContext } from "./memory";
import { enqueueMessage, getOrCreateQueue } from "./queue";
import type { QueuedMessage, SessionQueue } from "./queue";
import { sessionQueues } from "./queue";
import { isStopMessage, cancelSession } from "./cancel";
import { pollForVercelPreview } from "./github-reviews";
import { runCodexAuto } from "../../server/codex-appserver";
import { gitIdentityFor } from "../../server/shared/user-mappings";
import { sessionForChannel } from "../../server/slack-links";
import { tryGetSessionControl } from "../../server/session-control";
import {
  CLAUDE_CODE_BIN,
  isClaudeUsageLimitError,
  filterMcpServers,
  STRIPE_CONFIRM_TOOLS,
} from "../../server/claude-runner";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { getAgentAwsEnv } from "../../server/aws-creds";
import { pickAccount, markExhausted } from "../../server/claude-accounts";
import {
  getDefaultModel,
  DEFAULT_CODEX_MODEL,
  DEFAULT_FALLBACK_MODEL,
  providerFor,
  resolveModel,
  formatModelList,
} from "../../server/models";
import {
  isWorktreeChannel,
  getWorktreeDirForChannel,
  worktreeChannels,
} from "./worktree-channels";
import {
  activeSessions,
  pendingAnswers,
  getSessionKey,
  saveSession,
  loadSession,
  DEFAULT_CWD,
  SESSION_DIR,
  GITHUB_REPO,
  slackBotUserId,
  CANCELLED_ANSWER,
} from "./state";
import type { SlackSession, PendingAnswer } from "./state";

const ALLOWED_USER_ID = process.env.ALLOWED_SLACK_USER_ID;

// Cache admin MCP servers per session to avoid rebuilding identical tool objects
// on every message. Invalidated when memory changes (detected via hash).
const adminMcpServersCache = new Map<
  string,
  { tools: Record<string, any>; memoryHash: string }
>();

// Cache worktree existence checks per worktree dir (30s TTL)
const worktreeExistsCache = new Map<string, { exists: boolean; expiresAt: number }>();

// Cache thread context per channel+threadTs (30s TTL)
const threadContextCache = new Map<string, { context: string; expiresAt: number }>();

// Cached worktree existence check (TTL 30s) — avoids repeated fs.existsSync calls on every message
function cachedWorktreeExists(dir: string): boolean {
  const cached = worktreeExistsCache.get(dir);
  if (cached && cached.expiresAt > Date.now()) return cached.exists;
  const exists = existsSync(dir);
  worktreeExistsCache.set(dir, { exists, expiresAt: Date.now() + 30000 });
  return exists;
}

// Cached thread context (TTL 30s) — avoids refetching the same thread multiple times
async function cachedFetchThreadContext(channel: string, threadTs: string): Promise<string> {
  const cacheKey = `${channel}:${threadTs}`;
  const cached = threadContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.context;
  const context = await fetchThreadContext(channel, threadTs);
  threadContextCache.set(cacheKey, { context, expiresAt: Date.now() + 30000 });
  return context;
}

// Save the session and mirror claudeSessionId/lastActivity into the
// branch-named session file (written by `wt new-slack`), so backstage can
// dedupe the two into one session as soon as the id exists.
async function persistSession(session: SlackSession): Promise<void> {
  await saveSession(session);
  if (!session.branch) return;
  const branchFile = `${SESSION_DIR}/${session.branch}.json`;
  try {
    const bf = Bun.file(branchFile);
    if (await bf.exists()) {
      const branchData = JSON.parse(await bf.text());
      branchData.claudeSessionId = session.claudeSessionId;
      branchData.lastActivity = session.lastActivity;
      writeJsonAtomic(branchFile, branchData);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Worktree helpers
// ---------------------------------------------------------------------------

function branchExists(branch: string): boolean {
  try {
    const { spawnSync } = require("child_process");
    // Check if worktree directory exists
    const worktreeDir = `/home/ubuntu/worktrees/tella-fusion-${branch}`;
    const dirCheck = spawnSync("test", ["-d", worktreeDir]);
    if (dirCheck.status === 0) return true;
    // Check if branch exists in git (local or registered worktree)
    const gitCheck = spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: DEFAULT_CWD }
    );
    return gitCheck.status === 0;
  } catch {
    return false;
  }
}

function generateBranchName(text: string): string {
  // Heuristic: take first 2-3 words, lowercased, hyphen-separated, no special chars
  // Avoids a full Haiku query just for a branch name.
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .split(/\s+/) // Split on whitespace
    .filter((w) => w.length > 0) // Remove empty strings
    .slice(0, 3) // Take first 3 words
    .join("-") // Hyphenate
    .slice(0, 30); // Max 30 chars

  const baseName = words || "slack-task";

  // Deduplicate: if branch already exists, append a numeric suffix
  if (!branchExists(baseName)) return baseName;
  for (let i = 2; i <= 20; i++) {
    const candidate = `${baseName}-${i}`;
    if (!branchExists(candidate)) return candidate;
  }
  // Last resort: timestamp suffix
  return `${baseName}-${Date.now().toString(36)}`;
}

function createWorktree(
  branch: string,
  userId: string,
  message: string
): string {
  const worktreeDir = `/home/ubuntu/worktrees/tella-fusion-${branch}`;

  try {
    const { spawnSync } = require("child_process");
    const result = spawnSync(
      "/home/ubuntu/bin/wt",
      [
        "new-slack",
        branch,
        `--user=${userId}`,
        `--message=${(message || "").substring(0, 500)}`,
      ],
      { encoding: "utf-8", timeout: 120000 }
    );

    if (result.status !== 0) {
      const stderr =
        result.stderr?.trim() || result.stdout?.trim() || "unknown error";
      throw new Error(
        `wt new-slack exited with code ${result.status}: ${stderr}`
      );
    }
    console.log(`[slack] Created worktree: ${branch}`);
  } catch (e) {
    console.error(`[slack] Failed to create worktree ${branch}:`, e);
    throw e;
  }

  return worktreeDir;
}

// ---------------------------------------------------------------------------
// AskUserQuestion via Block Kit
// ---------------------------------------------------------------------------

async function handleAskUserQuestion(
  sessionKey: string,
  input: Record<string, unknown>,
  channel: string,
  threadTs: string
): Promise<PermissionResult> {
  const questions = input.questions as Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;

  if (!questions || questions.length === 0) {
    return { behavior: "allow", updatedInput: input };
  }

  const answers: Record<string, string> = {};

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const questionId = `${Date.now()}-${qIdx}`;

    // Build Block Kit blocks
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: q.header || "Question",
          emoji: true,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: q.question },
      },
    ];

    // Add option descriptions as context
    if (q.options.length > 0) {
      const descriptionLines = q.options
        .map(
          (opt, i) =>
            `*${i + 1}. ${opt.label}*${opt.description ? ` \u2014 ${opt.description}` : ""}`
        )
        .join("\n");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: descriptionLines },
      });
    }

    // Action buttons
    const buttons: any[] = q.options.map((opt, optIdx) => ({
      type: "button",
      text: {
        type: "plain_text",
        text: opt.label.substring(0, 75),
        emoji: true,
      },
      action_id: `askq-${questionId}-opt-${optIdx}`,
      value: opt.label,
    }));

    // "Other..." button
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: "Other...", emoji: true },
      action_id: `askq-${questionId}-other`,
      style: "primary",
    });

    blocks.push({
      type: "actions",
      elements: buttons,
    });

    // Post to Slack
    const postResult = await postSlackBlocks(
      channel,
      `Question: ${q.question}`,
      blocks,
      threadTs
    );
    const blockMsgTs = postResult?.ts || "";

    // Create promise to wait for answer
    const answer = await new Promise<string>((resolve) => {
      const timeoutId = setTimeout(() => {
        const pending = pendingAnswers.get(questionId);
        if (pending) {
          pendingAnswers.delete(questionId);
          // Update the message to show it timed out
          updateSlackBlocks(
            channel,
            blockMsgTs,
            `Question timed out: ${q.question}`,
            [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `~${q.question}~\n_Timed out \u2014 skipped_`,
                },
              },
            ]
          ).catch(() => {});
          // Tell the thread what was skipped and that we're proceeding anyway,
          // so a silent thread doesn't look stuck.
          sendSlackMessage(
            channel,
            `:hourglass_flowing_sand: No answer in 5 min, so I'm skipping *"${q.question}"* and proceeding with my best assumption. Reply anytime if I got it wrong.`,
            threadTs
          ).catch(() => {});
          resolve("__TIMED_OUT__");
        }
      }, 5 * 60 * 1000); // 5 minute timeout

      pendingAnswers.set(questionId, {
        resolve,
        messageTs: blockMsgTs,
        channel,
        threadTs,
        sessionKey,
        timeoutId,
        questionText: q.question,
        header: q.header || "Question",
      });
    });

    if (answer === "__TIMED_OUT__") {
      return {
        behavior: "deny",
        message: `Question "${q.question}" timed out after 5 minutes with no response. Proceed with your best assumption, and state clearly in your reply what you assumed for this question so the user can correct it if needed.`,
      };
    }

    if (answer === CANCELLED_ANSWER) {
      // Mark the open modal as cancelled and clean it up visually.
      updateSlackBlocks(channel, blockMsgTs, `Cancelled: ${q.question}`, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `~${q.question}~\n_Cancelled by user_`,
          },
        },
      ]).catch(() => {});
      return {
        behavior: "deny",
        message: "User cancelled the request.",
      };
    }

    answers[q.question] = answer;

    // Update the Block Kit message to show the selected answer
    await updateSlackBlocks(channel, blockMsgTs, `Answered: ${answer}`, [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${q.header || "Question"}*\n${q.question}\n\n*Answer:* ${answer}`,
        },
      },
    ]).catch(() => {});
  }

  return {
    behavior: "allow",
    updatedInput: { ...input, answers },
  };
}

// ---------------------------------------------------------------------------
// /model command — per-session model selection (Claude or Codex models)
// ---------------------------------------------------------------------------

/**
 * Handle "/model" / "/model <name>" in a Slack message. Returns true when the
 * message was consumed as a command (caller should stop processing).
 */
export async function handleModelCommand(
  sessionKey: string,
  text: string,
  channel: string,
  threadTs: string
): Promise<boolean> {
  if (!/^\/model(\s|$)/i.test(text.trim())) return false;

  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) activeSessions.set(sessionKey, session);
  }

  const arg = text.trim().replace(/^\/model\s*/i, "").trim();

  if (!arg || arg === "show" || arg === "list") {
    const current = session?.model || getDefaultModel();
    await sendSlackMessage(
      channel,
      `Current model: \`${current}\`${session?.model ? "" : " (default)"}\n\nAvailable (set with \`/model <name>\`):\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs
    );
    return true;
  }

  const resolved = resolveModel(arg);
  if (!resolved) {
    await sendSlackMessage(
      channel,
      `Unknown model \`${arg}\`. Available:\n\`\`\`\n${formatModelList(session?.model)}\n\`\`\``,
      threadTs
    );
    return true;
  }

  if (!session) {
    await sendSlackMessage(
      channel,
      `No session in this thread yet — send the task first, then \`/model ${resolved.id}\`. (New sessions start on \`${getDefaultModel()}\`.)`,
      threadTs
    );
    return true;
  }

  const prevProvider = providerFor(session.model);
  session.model = resolved.id;
  session.lastActivity = new Date().toISOString();
  await saveSession(session);

  let note = "";
  if (prevProvider !== resolved.provider) {
    note =
      resolved.provider === "codex"
        ? " This switches the engine to Codex — the Claude history doesn't carry over; the next message starts a fresh Codex thread in the same worktree."
        : " This switches back to Claude — the Codex thread's history doesn't carry over, but the earlier Claude history (if any) resumes.";
  }
  await sendSlackMessage(
    channel,
    `Model set to \`${resolved.id}\`. Applies from the next message.${note}`,
    threadTs
  );
  return true;
}

// ---------------------------------------------------------------------------
// processCodexMessage — runs a queued message on the Codex backend
// ---------------------------------------------------------------------------

async function processCodexMessage(
  session: SlackSession,
  sessionKey: string,
  msg: QueuedMessage,
  streamer: SlackStreamer,
  cwd: string,
  abortController: AbortController,
  dismissStopButton: (label: string) => Promise<void>,
  progress: SlackProgress,
  /** Run on this model without changing the session's configured model (fallback). */
  modelOverride?: string
): Promise<void> {
  const model = modelOverride || session.model || DEFAULT_CODEX_MODEL;
  console.log(
    `[slack] Running Codex SDK for ${sessionKey} in ${cwd}${session.codexThreadId ? ` (resuming ${session.codexThreadId})` : ""} (${model})`
  );

  let resultText = "";
  let resultThreadId = session.codexThreadId || "";
  const busyKey = `slack-${sessionKey}`;

  // Bridge the Slack queue's abort controller into the codex run
  const { cancelCodexRun } = await import("../../server/codex-runner");
  const onAbort = () => cancelCodexRun(resultThreadId || busyKey);
  abortController.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const event of runCodexAuto({
      prompt: msg.prompt,
      sessionId: session.codexThreadId || undefined,
      cwd,
      mode: "code",
      model,
      busyKeys: [busyKey],
      // Attribute commits to the Slack user who sent this message.
      author: gitIdentityFor(msg.userId),
      // No journal: interrupted Slack messages are re-delivered by the queue
    })) {
      if (abortController.signal.aborted) break;
      if (event.type === "init") {
        resultThreadId = event.sessionId || resultThreadId;
        console.log(`[slack] Codex thread initialized: ${resultThreadId}`);
      }
      if (event.type === "tool_use" && event.toolName && !isSilentTool(event.toolName)) {
        const status = buildToolStatus(event.toolName, event.toolInput);
        progress.setAction(status);
        await streamer.setStatus(status);
      }
      if (event.type === "done") {
        resultText = event.result || "";
      }
      if (event.type === "error") {
        resultText = `Error running Codex: ${event.content}`;
      }
    }
  } catch (e: any) {
    resultText = `Error running Codex: ${e.message || e}`;
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
  }

  if (abortController.signal.aborted) {
    console.log(`[slack] Codex run aborted for ${sessionKey}`);
    await streamer.error("Cancelled by user.");
    await streamer.clearStatus();
    await dismissStopButton("Cancelled");
    return;
  }

  session.codexThreadId = resultThreadId || session.codexThreadId;
  session.lastActivity = new Date().toISOString();
  await saveSession(session);

  const formatted = resultText ? markdownToSlack(resultText) : "";
  const truncated = formatted
    ? formatted.length > 3000
      ? formatted.substring(0, 3000) + "...(truncated)"
      : formatted
    : "Done! (no text output)";

  await streamer.stop(truncated);
  await streamer.clearStatus();
  await dismissStopButton("Done");
}

// ---------------------------------------------------------------------------
// processMessage — core: runs the Claude Agent SDK query()
// ---------------------------------------------------------------------------

export async function processMessage(
  sessionKey: string,
  msg: QueuedMessage
): Promise<void> {
  const { prompt, channel, userName, isNewSession } = msg;
  const threadTs = msg.threadTs;

  // Load or create session
  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) {
      activeSessions.set(sessionKey, session);
    }
  }

  if (isNewSession && !session) {
    session = {
      channel,
      threadTs,
      userId: msg.userName,
      claudeSessionId: null,
      worktreeDir: msg.worktreeDir || null,
      branch: msg.branch || null,
      mode: msg.worktreeDir ? "worktree" : "conversational",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
    activeSessions.set(sessionKey, session);
    // Persist immediately — the "Open in Backstage" link posted below points
    // at slack-<channel>-<ts>, which only resolves once this file exists.
    await saveSession(session);
  }

  if (!session) {
    console.error(`[slack] No session found for ${sessionKey}`);
    await sendSlackMessage(channel, "No active session found.", threadTs);
    return;
  }

  // Set up abort controller
  const abortController = new AbortController();
  const sq = getOrCreateQueue(sessionKey);
  sq.abortController = abortController;

  // MCP servers for this run, through the same runner-layer gate as backstage
  // sessions: filterMcpServers enforces per-user `allowedUsers` (keyed on the
  // requesting Slack user) and strips that field before the SDK sees it. The
  // old raw-config spread meant worktree/linked channels — which bypass
  // ALLOWED_USER_ID so the whole team can drive them — handed every teammate
  // user-restricted servers like brex.
  let mcpServers: Record<string, unknown> = {};
  try {
    mcpServers = filterMcpServers(undefined, msg.userId);
  } catch (e) {
    console.warn("[slack] Failed to load MCP config:", e);
  }

  // Set up streaming (stream starts lazily on first content)
  const streamer = new SlackStreamer(channel, threadTs, msg.userId);
  await streamer.setStatus("is thinking...");

  // Post a status message with the live Backstage session link and a Stop
  // button, so the run can be followed/cancelled even if Slack's assistant DM
  // disables the input field while we're working.
  const backstageUrl = `https://michael.taila5d766.ts.net/backstage/session/slack-${encodeURIComponent(sessionKey)}`;
  const backstageButton = {
    type: "button",
    text: { type: "plain_text", text: ":desktop_computer: Open in Backstage", emoji: true },
    url: backstageUrl,
    action_id: `backstage:${sessionKey}`,
  };

  // Action rows for the live progress card: Stop+Backstage while running,
  // Backstage-only once finished.
  const runningActions = {
    type: "actions",
    block_id: `stop-actions-${sessionKey}`,
    elements: [
      backstageButton,
      {
        type: "button",
        text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
        style: "danger",
        action_id: `stop:${sessionKey}`,
        value: sessionKey,
      },
    ],
  };
  const finalActions = {
    type: "actions",
    block_id: `backstage-link-${sessionKey}`,
    elements: [backstageButton],
  };

  let stopButtonTs: string | null = null;
  try {
    // Post the card with an initial progress section already rendered, so the
    // channel sees a visible reply immediately (the SlackProgress object then
    // edits this same message in place as work proceeds).
    const postResult = await postSlackBlocks(
      channel,
      "Working — follow along in Backstage or tap Stop to cancel.",
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":hourglass_flowing_sand: *Working…*",
          },
        },
        runningActions,
      ],
      threadTs
    );
    stopButtonTs = postResult?.ts || null;
  } catch (e) {
    console.warn("[slack] Failed to post stop button:", e);
  }

  // Live, in-place checklist on the card above. Works in channels (unlike the
  // DM-only assistant typing status), throttled to ~1 edit/sec.
  const progress = new SlackProgress(
    channel,
    stopButtonTs,
    [runningActions],
    [finalActions]
  );

  // Backwards-compatible alias: every exit path already calls this to collapse
  // the Stop button into the Backstage link. Now it also renders the terminal
  // checklist state.
  const dismissStopButton = (label: string): Promise<void> =>
    progress.finish(label);

  // Recreate worktree if it was cleaned up (revived thread)
  if (
    session.worktreeDir &&
    !cachedWorktreeExists(session.worktreeDir) &&
    session.branch
  ) {
    console.log(
      `[slack] [revive] Worktree ${session.branch} was cleaned up, recreating...`
    );
    // Transient activity line, not the header — otherwise the card stays stuck
    // on "Recreating worktree…" for the whole run after the (quick) recreate.
    progress.setAction("Recreating worktree…");
    await streamer.setStatus("recreating worktree...");
    try {
      const { spawnSync } = require("child_process");
      const branch = session.branch;
      const wtPath = session.worktreeDir;

      // Prune stale registrations
      spawnSync("git", ["worktree", "prune"], { cwd: DEFAULT_CWD });

      // Fetch latest main
      spawnSync("git", ["fetch", "origin", "main", "--quiet"], {
        cwd: DEFAULT_CWD,
        timeout: 30000,
      });

      // Create worktree — reuse existing branch or create from main
      let addResult;
      if (
        spawnSync(
          "git",
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          { cwd: DEFAULT_CWD }
        ).status === 0
      ) {
        addResult = spawnSync("git", ["worktree", "add", wtPath, branch], {
          cwd: DEFAULT_CWD,
          encoding: "utf-8",
          timeout: 60000,
        });
      } else {
        addResult = spawnSync(
          "git",
          ["worktree", "add", "-b", branch, wtPath, "main"],
          { cwd: DEFAULT_CWD, encoding: "utf-8", timeout: 60000 }
        );
      }

      if (addResult.status !== 0) {
        throw new Error(
          `git worktree add failed: ${addResult.stderr?.trim() || addResult.stdout?.trim()}`
        );
      }

      // Rebase on latest main
      spawnSync("git", ["pull", "origin", "main", "--rebase"], {
        cwd: wtPath,
        encoding: "utf-8",
        timeout: 60000,
      });

      // Copy env files (quick, no bun install — Claude can do that if needed)
      const envFiles = [
        [".envrc", ".envrc"],
        ["packages/core/webapp/.env.local", "packages/core/webapp/.env.local"],
        ["packages/core/instant/.env", "packages/core/instant/.env"],
        ["packages/core/temporal/.env", "packages/core/temporal/.env"],
      ];
      for (const [src, dst] of envFiles) {
        try {
          spawnSync("cp", [`${DEFAULT_CWD}/${src}`, `${wtPath}/${dst}`]);
        } catch {}
      }

      console.log(`[slack] [revive] Worktree ${branch} recreated`);
      // Reset Claude session since old one is stale after cleanup
      session.claudeSessionId = null;
      await saveSession(session);
    } catch (e) {
      console.error(
        `[slack] [revive] Failed to recreate worktree ${session.branch}:`,
        e
      );
      await streamer.error(`Failed to recreate worktree: ${e}`);
      await streamer.clearStatus();
      await dismissStopButton("Failed");
      return;
    }
  }

  const cwd = session.worktreeDir || DEFAULT_CWD;

  // Codex-provider models run through the Codex SDK instead of query()
  if (providerFor(session.model) === "codex") {
    await processCodexMessage(
      session,
      sessionKey,
      msg,
      streamer,
      cwd,
      abortController,
      dismissStopButton,
      progress
    );
    return;
  }

  console.log(
    `[slack] Running Claude SDK for ${sessionKey} in ${cwd}${session.claudeSessionId ? ` (resuming ${session.claudeSessionId})` : ""}`
  );

  let resultText = "";
  let resultSessionId = session.claudeSessionId || "";

  // Account rotation (same pool as the backstage runner): the sender's
  // personal sub first (matched via the identity table), shared pool as
  // backup; when a turn dies on usage limits, sideline the account and retry
  // on the next one. With everything exhausted, fall back to the codex model
  // (DEFAULT_FALLBACK_MODEL) as the last resort.
  const triedAccountIds = new Set<string>();
  let account = pickAccount(triedAccountIds, msg.userId, session.model);
  let limitExhausted = false;

  // --- Channel memory + self-management tools (interactive Slack only) -------
  // processMessage only ever runs for whitelisted users (gated at the event
  // handlers; worktree channels are team-only by design), so admin tools are
  // safe here. The powerful automation/MCP tools are further gated to the
  // configured trusted user; channel memory is available to anyone.
  let adminMcpServers: Record<string, any> = {};
  let memoryAppend = "";
  try {
    const kind = await getChannelKind(channel);
    const memCtx: MemoryContext = {
      channel,
      userId: msg.userId,
      isDM: kind.isDM,
      isPrivate: kind.isPrivate,
    };
    memoryAppend = await renderMemoryForPrompt(memCtx);
    const memoryHash = `${channel}:${msg.userId}:${memoryAppend}`.substring(0, 40); // Simple hash

    // Check cache: reuse admin tools if memory hasn't changed
    const cached = adminMcpServersCache.get(sessionKey);
    if (cached && cached.memoryHash === memoryHash) {
      adminMcpServers = cached.tools;
    } else {
      const isAdmin = !ALLOWED_USER_ID || msg.userId === ALLOWED_USER_ID;
      adminMcpServers = {
        "michael-admin": createAdminMcpServer({
          ...memCtx,
          createdBy: userName || msg.userId,
          isAdmin,
          threadTs: msg.threadTs,
        }),
        "michael-github": createGithubMcpServer({
          requestedBy: msg.userId,
          channel,
          threadTs: msg.threadTs,
        }),
        "michael-sessions": createSessionsMcpServer({
          createdBy: userName || msg.userId,
          isAdmin,
          currentSessionId: `slack-${sessionKey}`,
        }),
        "michael-humans": createHumansMcpServer({
          sessionId: `slack-${sessionKey}`,
          createdBy: userName || msg.userId,
          isAdmin,
        }),
      };
      adminMcpServersCache.set(sessionKey, { tools: adminMcpServers, memoryHash });
    }
  } catch (e) {
    console.warn("[slack] failed to build admin tools / memory:", e);
  }
  const ADMIN_TOOLS_PROMPT =
    "\n\n## Self-management\nYou can manage your own setup via the michael-admin MCP tools: " +
    "channel memory (remember / list_memory / forget) and, for trusted users, automations " +
    "(list/create/update/delete/run_automation — routines on a UTC cron, or event/webhook), one-off " +
    "scheduled runs (schedule_once — 'remind me about this next week', 'run this again in a week', or any " +
    "one-time task at a future time; it posts back to this thread by default and can DM/act via its MCPs), " +
    "and MCP connections (list/add/remove_mcp_server). When a user asks you to remember something, " +
    "set up a recurring job, schedule a reminder or future task, or connect a tool, use these tools rather than just describing how." +
    "\n\n## GitHub PR actions\nWhen asked to review, auto-fix, simplify, or adversarially review a tella-fusion PR " +
    "(e.g. \"review PR 4296\", \"auto-fix PR 4296\", \"adversarial review PR 4296\"), use the michael-github MCP tools " +
    "(review_pr / auto_fix_pr / simplify_pr / adversarial_review_pr) — they run the same actions as the PR labels and " +
    "post the results on the PR. Pass the PR number; the tool starts it and reports back, so just relay what it says." +
    "\n\n## Managing other sessions\nYou can see and steer every other Backstage session via the michael-sessions MCP tools. " +
    "Use list_sessions (filter 'waiting' to find sessions blocked on a question, 'active' for what's running) and get_session " +
    "to inspect state and transcripts. For trusted users: answer_session_question unblocks a session paused on a question, " +
    "send_to_session messages/redirects a running or idle session, cancel_session stops a run, and create_session spins up a new " +
    "ask- or code-mode session. When asked things like \"what's still running?\", \"what's waiting on me?\", or \"tell session X to …\", " +
    "use these tools. Combine with the gh CLI (Bash) for deeper PR status (CI checks, review state) beyond the PR link list_sessions already shows." +
    "\n\n## Human in the loop\nYou can pull a teammate into the loop via the michael-humans MCP: ask_human DMs them (as you, Michael) and folds their reply back into this session. " +
    "Use mode 'block' when you can't continue without the answer (your turn pauses until they reply — e.g. \"ask Grant for the copy\"), or 'async' (default) to keep working while you wait. " +
    "For async, deliver_when controls timing: 'now', 'when_done' (when this session next goes idle), 'on_pr' (once a PR is open — best for \"ask John for a review when done\"), or 'at_time' with a natural-language at_time. " +
    "Pass `options` for one-tap button choices, and `context` to attach background (the copy slot, a diff, a screen). Use list_pending_asks / cancel_ask to manage outstanding ones. " +
    "When the user says things like \"ask Grant for X\", \"get John to review when I'm done\", or \"check with Jaap before shipping\", use ask_human rather than just telling them to do it.";

  // Short-lived AWS read creds (instance-role snapshot, minted via the cgroup
  // escape in aws-creds.ts). The Slack child can't reach IMDS directly, and
  // process.env carries no AWS creds, so without this an `aws` call in-session
  // fails with "Unable to locate credentials". Mirrors the backstage runner
  // (claude-runner.ts childEnv). {} if minting fails — the run still proceeds.
  const awsEnv = await getAgentAwsEnv();

  rotation: for (;;) {
  let limitHit = false;
  let resultWasError = false;
  try {
    const q = query({
      prompt,
      options: {
        resume: resultSessionId || session.claudeSessionId || undefined,
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          ...awsEnv,
          ...(account ? { CLAUDE_CODE_OAUTH_TOKEN: account.token } : {}),
        },
        allowedTools: [
          "Bash",
          "Read",
          "Edit",
          "Write",
          "Grep",
          "Glob",
          "Task",
          "TaskOutput",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
          "EnterPlanMode",
          "ExitPlanMode",
          "TaskCreate",
          "TaskUpdate",
          "TaskList",
          "TaskGet",
          "Skill",
          "ListMcpResourcesTool",
          "ReadMcpResourceTool",
          "ToolSearch",
        ],
        canUseTool: async (toolName, input, options) => {
          if (toolName === "AskUserQuestion") {
            return handleAskUserQuestion(
              sessionKey,
              input,
              channel,
              threadTs
            );
          }
          // Money-moving Stripe tools need the per-call human confirmation the
          // backstage runner provides; this path has no approval card, so deny.
          if (toolName in STRIPE_CONFIRM_TOOLS) {
            return {
              behavior: "deny",
              message:
                "This Stripe action requires human confirmation — open this session in Backstage and retry there; the approval card will appear in that UI.",
            };
          }
          // Allow everything else that isn't in allowedTools (e.g. MCP tools)
          return { behavior: "allow", updatedInput: cleanPlainToolInput(toolName, input) };
        },
        mcpServers: { ...mcpServers, ...adminMcpServers },
        strictMcpConfig: true,
        model: session.model || getDefaultModel(),
        pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
        executable: "bun",
        abortController,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: SLACK_SYSTEM_PROMPT_APPEND + ADMIN_TOOLS_PROMPT + memoryAppend,
        },
        settingSources: ["user", "project"],
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                async (
                  input: PostToolUseHookInput | any
                ): Promise<HookJSONOutput> => {
                  const command = input?.tool_input?.command || "";
                  if (
                    typeof command === "string" &&
                    command.includes("git push")
                  ) {
                    const PATH = `/home/ubuntu/.cargo/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/home/ubuntu/bin:/home/ubuntu/.npm-global/bin:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
                    try {
                      console.log(
                        `[slack] [hook] Running just format after git push in ${cwd}`
                      );
                      execSync("just format", {
                        cwd,
                        encoding: "utf-8",
                        timeout: 120000,
                        env: { ...process.env, PATH },
                      });
                      const diff = execSync(
                        "git diff --quiet 2>&1; echo $?",
                        { cwd, encoding: "utf-8" }
                      ).trim();
                      if (diff !== "0") {
                        execSync(
                          'git add -u && git commit -m "format" && git push',
                          {
                            cwd,
                            encoding: "utf-8",
                            timeout: 60000,
                          }
                        );
                        console.log(
                          `[slack] [hook] Format commit pushed in ${cwd}`
                        );
                      }
                    } catch (e) {
                      console.error(
                        `[slack] [hook] Format after push failed:`,
                        e
                      );
                    }
                  }
                  // Detect PR creation and poll for Vercel preview
                  if (
                    typeof command === "string" &&
                    command.includes("gh pr create")
                  ) {
                    const response = String(input?.tool_response || "");
                    const prMatch = response.match(
                      /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
                    );
                    if (prMatch) {
                      const prNumber = parseInt(prMatch[1], 10);
                      console.log(
                        `[slack] [hook] PR #${prNumber} created, polling for Vercel preview`
                      );
                      pollForVercelPreview(prNumber, channel, threadTs).catch(
                        (e) =>
                          console.error(
                            `[slack] [vercel] Preview poll error:`,
                            e
                          )
                      );
                    }
                  }
                  return {} as HookJSONOutput;
                },
              ],
            },
          ],
        },
      },
    });

    for await (const sdkMsg of q) {
      if (abortController.signal.aborted) break;

      if (sdkMsg.type === "system" && sdkMsg.subtype === "init") {
        resultSessionId = (sdkMsg as any).session_id;
        console.log(
          `[slack] SDK session initialized: ${resultSessionId}`
        );
        // Persist the id right away — the backstage UI resolves the live
        // transcript (and dedupes the branch-named session) through it, so
        // waiting until the run ends leaves the session page empty.
        if (resultSessionId && resultSessionId !== session.claudeSessionId) {
          session.claudeSessionId = resultSessionId;
          await persistSession(session);
        }
      }

      // Update the live progress checklist + assistant thread status from tools
      if (sdkMsg.type === "assistant" && (sdkMsg as any).message?.content) {
        const content = (sdkMsg as any).message.content;
        for (const block of content as any[]) {
          if (block.type !== "tool_use") continue;

          // TodoWrite -> the model's own plan IS the checklist (Claude Tag style)
          if (block.name === "TodoWrite") {
            progress.setTodos(block.input?.todos);
            continue;
          }

          // TaskCreate -> use activeForm as status (high-level progress)
          if (block.name === "TaskCreate") {
            const status =
              block.input?.activeForm ||
              block.input?.subject ||
              "Working...";
            progress.setAction(status);
            await streamer.setStatus(status);
            continue;
          }

          // Skip silent/read-only tools — don't change status
          if (isSilentTool(block.name)) continue;

          // Write/action tools -> show what's happening
          const status = buildToolStatus(block.name, block.input);
          progress.setAction(status);
          await streamer.setStatus(status);
        }
      }

      if (sdkMsg.type === "result") {
        const resultMsg = sdkMsg as SDKResultMessage;
        if (resultMsg.subtype === "success") {
          resultText = resultMsg.result || "";
        } else {
          resultText = `Error: ${(resultMsg as any).errors?.join(", ") || "Unknown error"}`;
          resultWasError = true;
        }
        resultSessionId = resultMsg.session_id;
        console.log(
          `[slack] Claude SDK finished. Session ID: ${resultSessionId}, subtype: ${resultMsg.subtype}`
        );
      }
    }
    if (isClaudeUsageLimitError(resultText, resultWasError)) limitHit = true;
  } catch (e: any) {
    if (abortController.signal.aborted) {
      console.log(`[slack] SDK query aborted for ${sessionKey}`);
      await streamer.error("Cancelled by user.");
      await streamer.clearStatus();
      await dismissStopButton("Cancelled");
      return;
    }
    console.error(`[slack] SDK query error for ${sessionKey}:`, e);
    if (isClaudeUsageLimitError(e.message || String(e), true)) {
      limitHit = true;
    } else {
      resultText = `Error running Claude: ${e.message || e}`;
    }
  }

  if (!limitHit) break rotation;

  // Usage limit: sideline the account (if any) and rotate
  if (account) {
    triedAccountIds.add(account.id);
    markExhausted(account.id, session.model);
  }
  const next = pickAccount(triedAccountIds, msg.userId, session.model);
  if (next && next.id !== account?.id) {
    account = next;
    console.warn(`[slack] Usage limit hit for ${sessionKey}; retrying on account ${next.name}`);
    await streamer.setStatus(`usage limit hit — retrying on ${next.name}...`);
    continue rotation;
  }
  limitExhausted = true;
  break rotation;
  } // rotation

  // Every Claude account exhausted → last resort: the codex fallback model
  if (limitExhausted) {
    const fallback = DEFAULT_FALLBACK_MODEL ? resolveModel(DEFAULT_FALLBACK_MODEL) : null;
    if (fallback?.provider === "codex") {
      console.warn(`[slack] Claude usage exhausted for ${sessionKey}; falling back to ${fallback.id}`);
      await sendSlackMessage(
        channel,
        `:warning: Claude usage limits exhausted on all accounts — continuing on \`${fallback.id}\` (Codex). History from this thread doesn't carry over to the Codex engine.`,
        threadTs
      );
      await processCodexMessage(
        session,
        sessionKey,
        msg,
        streamer,
        cwd,
        abortController,
        dismissStopButton,
        progress,
        fallback.id
      );
      return;
    }
    resultText =
      resultText ||
      "Claude usage limits exhausted on all accounts and no fallback model is configured.";
  }

  // Update session
  session.claudeSessionId = resultSessionId || session.claudeSessionId;
  session.lastActivity = new Date().toISOString();
  await persistSession(session);

  // Send result to Slack via streamer (convert markdown -> Slack mrkdwn)
  const formatted = resultText ? markdownToSlack(resultText) : "";
  const truncated = formatted
    ? formatted.length > 3000
      ? formatted.substring(0, 3000) + "...(truncated)"
      : formatted
    : "Done! (no text output)";

  await streamer.stop(truncated);
  await streamer.clearStatus();
  await dismissStopButton("Done");
}

// ---------------------------------------------------------------------------
// handleMessageEvent — DM messages
// ---------------------------------------------------------------------------

export async function handleMessageEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const text = event.text || "";

  if (!text.trim()) return;

  // Human-in-the-loop: is this a teammate replying to a question Michael DM'd
  // them on behalf of a session? If so, route it back into that session and stop
  // — do NOT treat it as a new request to Michael. This is the one path that
  // deliberately accepts a message from someone other than the trusted user
  // (matchReply only matches the exact person asked, in that ask's DM). Runs
  // before the allow-list gate below for exactly that reason; it's tightly
  // scoped and every accepted reply is audited.
  const matchedAsk = matchHumanAskReply({ channel, user, threadTs: thread_ts, text });
  if (matchedAsk) {
    console.log(`[slack] Routed reply from ${user} into session ${matchedAsk.sessionId} (ask ${matchedAsk.id})`);
    await addReaction(channel, ts, "white_check_mark").catch(() => {});
    await sendSlackMessage(
      channel,
      ":inbox_tray: Got it — passing that straight to the session. Thanks!",
      thread_ts || ts
    ).catch(() => {});
    return;
  }

  const isDM = channel.startsWith("D");
  // For DMs: thread_ts means a reply in an existing thread; no thread_ts means
  // a new top-level message (e.g. Slack's "New Chat"). Use ts as the thread
  // anchor so each top-level DM starts its own session/worktree.
  const threadTs = thread_ts || ts;
  const sessionKey = getSessionKey(channel, threadTs);

  console.log(
    `[slack] Message from ${user} in ${channel}: ${text.substring(0, 50)}...`
  );

  if (ALLOWED_USER_ID && user !== ALLOWED_USER_ID) {
    console.log(`[slack] Ignoring message from non-allowed user: ${user}`);
    return;
  }

  // Handle stop/cancel keywords
  if (isStopMessage(text)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(
        channel,
        "Cancelled. Queue cleared.",
        threadTs || ts
      );
    } else {
      await sendSlackMessage(channel, "Nothing to cancel.", threadTs || ts);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, text, channel, threadTs || ts)) {
    return;
  }

  // Add eyes reaction to acknowledge
  await addReaction(channel, ts, "eyes");

  // Check for existing session
  let session: SlackSession | undefined = activeSessions.get(sessionKey);
  if (!session) {
    session = (await loadSession(sessionKey)) ?? undefined;
    if (session) {
      activeSessions.set(sessionKey, session);
    }
  }

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  if (session) {
    // Continue existing session
    console.log(`[slack] Continuing session: ${sessionKey}`);
    session.lastActivity = new Date().toISOString();

    enqueueMessage(sessionKey, {
      prompt: text,
      channel,
      threadTs: threadTs || ts,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: false,
    });
  } else {
    // New session — always create a worktree
    console.log(`[slack] New session: ${sessionKey}, mode: worktree`);

    let worktreeDir: string | undefined;
    let branch: string | undefined;
    let prompt: string;

    try {
      branch = generateBranchName(text);
      worktreeDir = createWorktree(branch, user, text);

      prompt = `${userName} sent me a Slack message:

"${text}"

---

I'm now in a worktree (branch: ${branch}) for this task. Please analyze what needs to be done and help with this request. Start by exploring the codebase to understand the relevant code.`;
    } catch (e) {
      await sendSlackMessage(
        channel,
        `${MESSAGES.error} Failed to create worktree: ${e}`,
        threadTs || ts
      );
      await removeReaction(channel, ts, "eyes").catch(() => {});
      return;
    }

    enqueueMessage(sessionKey, {
      prompt,
      channel,
      threadTs: threadTs || ts,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: true,
      worktreeDir,
      branch,
    });
  }
}

// ---------------------------------------------------------------------------
// handleMentionEvent — @mention in channels
// ---------------------------------------------------------------------------

const UI_BASE = process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

/**
 * Slack card for a triggered PR action. While running: Open-in-Backstage + Stop.
 * Once done: Stop is dropped (it's useless) and a "finished" note is added.
 */
function prActionCardBlocks(message: string, bksId: string, running: boolean): any[] {
  const backstageButton = {
    type: "button",
    text: { type: "plain_text", text: ":desktop_computer: Open in Backstage", emoji: true },
    url: `${UI_BASE}/session/${bksId}`,
    action_id: `backstage:${bksId}`,
  };
  const stopButton = {
    type: "button",
    text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
    style: "danger",
    action_id: `pr-stop:${bksId}`,
    value: bksId,
  };
  // On completion we just drop the Stop button — the separate "✓ Finished" reply
  // (posted by the caller) is the completion signal, so no redundant footer here.
  return [
    { type: "section", text: { type: "mrkdwn", text: message } },
    {
      type: "actions",
      block_id: `pr-action-${bksId}`,
      elements: running ? [backstageButton, stopButton] : [backstageButton],
    },
  ];
}

export async function handleMentionEvent(event: any): Promise<void> {
  const { channel, user, ts, thread_ts } = event;
  const text = event.text || "";

  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!cleanText) return;

  console.log(
    `[slack] Mention from ${user} in ${channel}: ${cleanText?.substring(0, 50)}...`
  );

  // Worktree channels — and channels linked to a backstage session — bypass the
  // ALLOWED_USER_ID check so the whole team can drive the work from the channel.
  const inWorktreeChannel = isWorktreeChannel(channel);
  const linkedSessionId = sessionForChannel(channel);

  if (
    !inWorktreeChannel &&
    !linkedSessionId &&
    ALLOWED_USER_ID &&
    user !== ALLOWED_USER_ID
  ) {
    console.log(`[slack] Ignoring mention from non-allowed user: ${user}`);
    return;
  }

  // Linked channel: @Michael drives the linked backstage session in its own
  // context (its worktree + claude session). The reply is mirrored back to this
  // channel by runSessionPrompt. This "channel drives the session" path takes
  // precedence over the worktree/intent routing below.
  if (linkedSessionId) {
    const control = tryGetSessionControl();
    if (control) {
      await addReaction(channel, ts, "eyes");
      const info = await getUserInfo(user);
      await control.deliverToSession(
        linkedSessionId,
        cleanText,
        info?.real_name || user,
      );
      return;
    }
  }

  // For worktree channels, use channel ID as session key (one session per worktree)
  // so all threads share the same Claude session context
  const threadTs = thread_ts || ts;
  const sessionKey = inWorktreeChannel
    ? channel
    : getSessionKey(channel, threadTs);

  // Handle stop/cancel keywords
  if (isStopMessage(cleanText)) {
    const didCancel = cancelSession(sessionKey);
    if (didCancel) {
      await addReaction(channel, ts, "octagonal_sign");
      await sendSlackMessage(channel, "Cancelled. Queue cleared.", threadTs);
    }
    return;
  }

  // Handle /model — set or show this session's model
  if (await handleModelCommand(sessionKey, cleanText, channel, threadTs)) {
    return;
  }

  await addReaction(channel, ts, "eyes");

  const userInfo = await getUserInfo(user);
  const userName = userInfo?.real_name || user;

  // Worktree channel: route to existing worktree session
  if (inWorktreeChannel) {
    const worktreeDir = getWorktreeDirForChannel(channel)!;
    const branch = worktreeChannels.get(channel)!;

    console.log(
      `[slack] Worktree channel mention from ${userName} for branch ${branch} (session: ${sessionKey})`
    );

    // Check for existing session
    let session: SlackSession | undefined = activeSessions.get(sessionKey);
    if (!session) {
      session = (await loadSession(sessionKey)) ?? undefined;
      if (session) {
        activeSessions.set(sessionKey, session);
      }
    }

    // Fetch thread/channel context
    let context = "";
    if (thread_ts) {
      context = await cachedFetchThreadContext(channel, thread_ts);
    }

    let prompt: string;
    if (session) {
      // Continue existing session
      prompt = context
        ? `${userName} said (in a thread):\n\nThread context:\n---\n${context}\n---\n\nTheir message: "${cleanText}"`
        : `${userName} said: "${cleanText}"`;
    } else {
      // New session for this worktree channel
      prompt = `${userName} tagged me in the #worktree-${branch} Slack channel.

I'm working in worktree branch \`${branch}\` at \`${worktreeDir}\`.
${context ? `\nThread context:\n---\n${context}\n---\n` : ""}
Their message: "${cleanText}"

Please help with this request. Start by exploring the codebase to understand what's relevant.`;
    }

    enqueueMessage(sessionKey, {
      prompt,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: !session,
      worktreeDir,
      branch,
    });
    return;
  }

  // Regular (non-worktree) channel mention. A quick Haiku classifier decides the
  // route: an explicit PR action runs directly (no worktree), a question runs
  // in-thread in the main checkout (no worktree), and a coding task spins up a
  // worktree as before. Fail-open: a null verdict falls through to the code path.
  const intent = await classifyMention(cleanText);

  if (intent && intent.action !== "none" && intent.prNumber) {
    // Carry the message text as steer so any specific guidance reaches the run.
    const res = await triggerPrAction(intent.action, intent.prNumber, user, cleanText);
    if (res.ok && res.bksId) {
      const msg = `On it — ${res.message}`;
      const bksId = res.bksId;
      const posted = await postSlackBlocks(channel, msg, prActionCardBlocks(msg, bksId, true), threadTs);
      const cardTs = posted?.ts;
      // When the run finishes: drop the Stop button and report back in-thread.
      if (res.done) {
        const url = res.url;
        void res.done.finally(() => {
          if (cardTs) {
            void updateSlackBlocks(channel, cardTs, msg, prActionCardBlocks(msg, bksId, false)).catch(() => {});
          }
          void sendSlackMessage(
            channel,
            `✓ Finished — results are on the PR${url ? `: ${url}` : ""}`,
            threadTs,
          ).catch(() => {});
        });
      }
    } else {
      await sendSlackMessage(channel, res.message, threadTs);
    }
    return;
  }

  // Only thread mentions get surrounding context: a thread is one coherent
  // conversation, while channel history is mostly other people's unrelated
  // requests and would leak into the session prompt.
  let context = "";
  if (thread_ts) {
    context = await cachedFetchThreadContext(channel, thread_ts);
  }

  // Ask mode: a question/discussion — answer in-thread in the main checkout, no
  // worktree or dedicated channel.
  if (intent?.mode === "ask") {
    let askSession: SlackSession | undefined =
      activeSessions.get(sessionKey) ?? (await loadSession(sessionKey)) ?? undefined;
    if (askSession) activeSessions.set(sessionKey, askSession);
    const intro = context
      ? `${userName} asked me in a Slack thread (with context):\n\n---\n${context}\n---\n\nTheir question: "${cleanText}"`
      : `${userName} asked me in Slack: "${cleanText}"`;
    enqueueMessage(sessionKey, {
      prompt: `${intro}\n\nThis is a question/discussion, not a coding task — don't create a branch or change code. Read the codebase as needed for context and answer concisely.`,
      channel,
      threadTs,
      messageTs: ts,
      userName,
      userId: user,
      isNewSession: !askSession,
      // No worktreeDir → runs conversationally in the main checkout, replies in-thread.
    });
    return;
  }

  // Code mode: a real coding task — spin up a worktree (existing behavior).
  let worktreeDir: string | undefined;
  let branch: string | undefined;
  let prompt: string;

  try {
    branch = await generateBranchName(cleanText);
    worktreeDir = createWorktree(branch, user, cleanText);

    const intro = context
      ? `${userName} tagged me in a Slack thread with this context:

---
${context}
---

Their message: "${cleanText}"`
      : `${userName} tagged me in a Slack channel with this message: "${cleanText}"`;

    prompt = `${intro}

I'm now in a worktree (branch: ${branch}) for this task. Please help with this request. Start by exploring the codebase to understand the relevant code.`;
  } catch (e) {
    await sendSlackMessage(
      channel,
      `${MESSAGES.error} Failed to create worktree: ${e}`,
      threadTs
    );
    await removeReaction(channel, ts, "eyes").catch(() => {});
    return;
  }

  enqueueMessage(sessionKey, {
    prompt,
    channel,
    threadTs,
    messageTs: ts,
    userName,
    userId: user,
    isNewSession: true,
    worktreeDir,
    branch,
  });
}
