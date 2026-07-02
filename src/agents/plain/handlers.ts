/**
 * Plain agent webhook and mention handlers.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { SnoozeStatusDetail } from "@team-plain/typescript-sdk";
import { cleanPlainToolInput } from "../../server/shared/note-style";
import {
  getThreadWithMessages,
  postNote,
  sendCustomerReply,
  formatThreadContext,
  cleanDraftText,
  createLinearIssue,
  plain,
} from "./api";
import { buildMentionPrompt, buildWorkPrompt, buildRefundExecutionPrompt } from "./prompts";
import { getDefaultModel } from "../../server/models";
import { STRIPE_CONFIRM_TOOLS, filterMcpServers } from "../../server/claude-runner";
import { classifyRefundApproval } from "./refund-intent";

const TELLA_FUSION_DIR = "/home/ubuntu/projects/tella-fusion";

// --- State ---

const processedMessages = new Set<string>();

interface ActiveSession {
  threadId: string;
  customerId: string;
  branch: string;
  worktreeDir: string;
  claudeSessionId: string | null;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}
export const activeSessions = new Map<string, ActiveSession>();

interface PendingConfirmation {
  threadId: string;
  customerId: string;
  type: "customer_reply";
  draftText: string;
  timestamp: number;
}
export const pendingConfirmations = new Map<string, PendingConfirmation>();

// --- Webhook payload type ---

export interface PlainWebhookPayload {
  type: string;
  timestamp: string;
  workspaceId: string;
  payload: {
    thread: {
      id: string;
      externalId?: string;
      title?: string;
      previewText?: string;
      status: string;
      customer: {
        id: string;
        email?: { email: string };
        fullName?: string;
        externalId?: string;
      };
    };
    previousThread?: { id: string; status: string };
    email?: {
      id: string;
      to: { email: string; name?: string };
      from: { email: string; name?: string };
      subject?: string;
      textContent?: string;
      markdownContent?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
    chat?: {
      id: string;
      text?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
    note?: {
      id: string;
      text?: string;
      markdown?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
  };
}

// --- Claude runner (Agent SDK) ---

async function runClaude(
  prompt: string,
  cwd: string = TELLA_FUSION_DIR,
  resumeSessionId?: string,
  // Money-moving Stripe tools (refunds/cancellations) are denied unless this is
  // the approved "@michael go ahead" execution path. Closes the gap where any
  // @michael note ran with every tool — including Stripe writes — allowed.
  allowMoneyTools: boolean = false
): Promise<{ result: string; sessionId: string }> {
  console.log(`[plain] Running Claude SDK in ${cwd}${resumeSessionId ? ` (resuming ${resumeSessionId})` : ""}${allowMoneyTools ? " [money tools UNLOCKED]" : ""}`);

  let result = "";
  let sessionId = resumeSessionId || "";

  try {
    const q = query({
      prompt,
      options: {
        resume: resumeSessionId || undefined,
        cwd,
        // Untrusted customer ticket text goes into this child — same minimal
        // env as the Haiku classifier calls (ticket-router.ts), no tokens from
        // ~/.backstage.env. MCP servers carry their own credentials.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG,
          ...(process.env.MICHAEL_MODEL ? { MICHAEL_MODEL: process.env.MICHAEL_MODEL } : {}),
        },
        allowedTools: [
          "Bash", "Read", "Edit", "Write", "Grep", "Glob",
          "Task", "TaskOutput", "WebFetch", "WebSearch",
          "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
          "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
        ],
        canUseTool: async (toolName: string, input: unknown) => {
          if (!allowMoneyTools && toolName in STRIPE_CONFIRM_TOOLS) {
            return {
              behavior: "deny" as const,
              message:
                "Money-moving Stripe actions (refunds/cancellations) can't run from a normal @michael note. " +
                "They must be proposed by triage and then approved with an explicit '@michael go ahead' on that proposal. " +
                "Describe the proposed action instead.",
            };
          }
          return {
            behavior: "allow" as const,
            updatedInput: cleanPlainToolInput(toolName, input as Record<string, unknown>),
          };
        },
        // Runner-layer MCP gate with NO user: Plain runs are automation-like
        // (they process untrusted ticket text), so any `allowedUsers`-restricted
        // server is fail-closed invisible here.
        mcpServers: filterMcpServers(undefined, undefined) as any,
        strictMcpConfig: true,
        model: getDefaultModel(),
        pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude",
        executable: "bun",
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
        },
        settingSources: ["user", "project"],
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        sessionId = (msg as any).session_id || sessionId;
      }

      if (msg.type === "result") {
        const rm = msg as any;
        sessionId = rm.session_id || sessionId;
        result = rm.subtype === "success" ? (rm.result || "") : `Error: ${rm.errors?.join(", ") || "Unknown"}`;
        console.log(`[plain] Claude finished. Session ID: ${sessionId}`);
      }
    }
  } catch (e: any) {
    console.error(`[plain] Claude SDK error:`, e);
    result = `Error: ${e.message || String(e)}`;
  }

  return { result, sessionId };
}

// --- Worktree creation ---

function createWorktree(branch: string, ticketId: string, title: string, description: string): string {
  const worktreeDir = `/home/ubuntu/worktrees/tella-fusion-${branch}`;

  const { spawnSync } = require("child_process");
  const result = spawnSync(
    "/home/ubuntu/bin/wt",
    [
      "new-linear",
      branch,
      `--ticket-id=${ticketId}`,
      `--title=${title}`,
      `--description=${description}`,
      `--url=`,
    ],
    {
      stdio: "inherit",
      timeout: 120000,
    }
  );

  if (result.status !== 0) {
    throw new Error(`wt new-linear exited with code ${result.status}`);
  }
  console.log(`[plain] Created worktree: ${branch}`);
  return worktreeDir;
}

// --- Handlers ---

async function handleMichaelMention(
  threadId: string,
  customerId: string,
  noteText: string,
  thread: any
): Promise<void> {
  console.log(`[plain] Processing @michael mention in thread ${threadId}`);

  const request = noteText.replace(/@michael/gi, "").trim();

  // Check for confirmation of pending actions
  const pending = pendingConfirmations.get(threadId);
  if (
    pending &&
    (request.toLowerCase().includes("yes") ||
      request.toLowerCase().includes("send") ||
      request.toLowerCase().includes("confirm") ||
      request.toLowerCase().includes("create"))
  ) {
    pendingConfirmations.delete(threadId);

    if (pending.type === "customer_reply") {
      const sent = await sendCustomerReply(threadId, customerId, pending.draftText);
      if (sent) {
        try {
          await plain.snoozeThread({
            threadId,
            statusDetail: SnoozeStatusDetail.WaitingForCustomer,
          });
          await postNote(threadId, customerId, "✓ Reply sent to customer. Thread set to Waiting for Customer.");
        } catch (e) {
          console.error("Error setting thread status:", e);
          await postNote(threadId, customerId, "✓ Reply sent to customer.");
        }
      } else {
        await postNote(threadId, customerId, "✗ Failed to send reply to customer.");
      }
      return;
    }
  }

  const threadContext = formatThreadContext(thread, true);

  // Refund/cancellation approval: a teammate approving a refund Michael proposed
  // earlier in this thread. Fail-closed classifier; only this path unlocks the
  // Stripe money tools, and only to execute the EXACT proposed action.
  const refundVerdict = await classifyRefundApproval(request, threadContext);
  if (refundVerdict.approve) {
    console.log(`[plain] Refund go-ahead on thread ${threadId}: ${refundVerdict.reason}`);
    try {
      const { result } = await runClaude(
        buildRefundExecutionPrompt(request, threadContext),
        TELLA_FUSION_DIR,
        undefined,
        /*allowMoneyTools*/ true
      );
      // If it produced a customer draft, route it through the existing
      // "@michael yes - to send" confirmation; otherwise post its note as-is.
      const draftMatch = result.match(/DRAFT REPLY:\s*([\s\S]*?)(?:$|(?=\n##|\n---))/i);
      if (draftMatch) {
        const draft = cleanDraftText(draftMatch[1]);
        const summary = result.slice(0, draftMatch.index).trim();
        if (summary) await postNote(threadId, customerId, summary);
        pendingConfirmations.set(threadId, {
          threadId,
          customerId,
          type: "customer_reply",
          draftText: draft,
          timestamp: Date.now(),
        });
        await postNote(
          threadId,
          customerId,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n@michael yes - to send this reply`,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n*@michael yes* - to send this reply`
        );
      } else {
        await postNote(threadId, customerId, result);
      }
    } catch (e) {
      console.error("[plain] Error executing approved refund:", e);
      await postNote(threadId, customerId, `Error executing the approved refund: ${e}. No money was moved if Stripe wasn't reached — please verify in Stripe.`);
    }
    return;
  }

  const prompt = buildMentionPrompt(request, threadContext);

  try {
    const { result } = await runClaude(prompt);

    console.log(`[plain] Claude response (first 500 chars): ${result.substring(0, 500)}`);

    // Draft reply
    if (result.includes("DRAFT REPLY:")) {
      const draftMatch = result.match(/DRAFT REPLY:\s*([\s\S]*?)(?:$|(?=\n##|\n---))/i);
      if (draftMatch) {
        const draft = cleanDraftText(draftMatch[1]);
        if (!draft) {
          console.log("[plain] WARNING: Draft was empty after cleaning!");
        }
        pendingConfirmations.set(threadId, {
          threadId,
          customerId,
          type: "customer_reply",
          draftText: draft,
          timestamp: Date.now(),
        });

        await postNote(
          threadId,
          customerId,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n@michael yes - to send this reply`,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n*@michael yes* - to send this reply`
        );
        return;
      }
    }

    // Code work
    if (result.includes("CODE WORK NEEDED:")) {
      const codeMatch = result.match(/CODE WORK NEEDED:\s*([\s\S]*?)(?:$|(?=\n\n[A-Z]))/i);
      if (codeMatch) {
        const codeDescription = codeMatch[1].trim();
        await postNote(
          threadId,
          customerId,
          `**Code work suggested:**\n\n${codeDescription}\n\n---\n\n@michael start worktree - to begin working on this`,
          `**Code work suggested:**\n\n${codeDescription}\n\n---\n\n*@michael start worktree* - to begin working on this`
        );
        return;
      }
    }

    // Linear issue
    if (result.includes("LINEAR ISSUE:")) {
      const issueMatch = result.match(/LINEAR ISSUE:\s*([\s\S]*?)(?:$|(?=\n\n[A-Z]))/i);
      if (issueMatch) {
        const issueText = issueMatch[1].trim();
        const titleMatch = issueText.match(/Title:\s*(.+?)(?:\n|$)/i);
        const descMatch = issueText.match(/Description:\s*([\s\S]*?)(?:$)/i);

        if (titleMatch) {
          const title = titleMatch[1].trim();
          const description = descMatch ? descMatch[1].trim() : issueText;

          const issue = await createLinearIssue(title, description);
          if (issue) {
            await postNote(
              threadId,
              customerId,
              `Created Linear issue: ${issue.identifier}\n${issue.url}`,
              `Created Linear issue: [${issue.identifier}](${issue.url})`
            );
          } else {
            await postNote(threadId, customerId, `Failed to create Linear issue. Check Linear auth (OAuth token store / LINEAR_API_KEY) in the backstage logs.`);
          }
          return;
        }
      }
    }

    // Start worktree command
    if (request.toLowerCase().includes("start worktree")) {
      const branchName = `plain-${threadId.substring(0, 8)}`;
      const title = thread.title || "Support ticket work";

      try {
        const issue = await createLinearIssue(
          title,
          `Work from Plain support thread.\n\nThread: ${threadId}\nCustomer: ${thread.customer.fullName || thread.customer.email?.email || "Unknown"}`
        );

        if (issue) {
          const worktreeDir = createWorktree(branchName, issue.identifier, title, result);

          const session: ActiveSession = {
            threadId,
            customerId,
            branch: branchName,
            worktreeDir,
            claudeSessionId: null,
            linearIssueId: issue.id,
            linearIssueIdentifier: issue.identifier,
          };
          activeSessions.set(threadId, session);

          await postNote(
            threadId,
            customerId,
            `Started worktree for code work.\n\nBranch: ${branchName}\nLinear: ${issue.identifier} (${issue.url})\nDirectory: ${worktreeDir}\n\n@michael work on <description> - to have me work on something in this worktree`,
            `Started worktree for code work.\n\n- **Branch:** \`${branchName}\`\n- **Linear:** [${issue.identifier}](${issue.url})\n- **Directory:** \`${worktreeDir}\`\n\n*@michael work on \\<description\\>* - to have me work on something in this worktree`
          );
        } else {
          await postNote(threadId, customerId, "Failed to create Linear issue for worktree. Check Linear auth (OAuth token store / LINEAR_API_KEY) in the backstage logs.");
        }
      } catch (e) {
        console.error("Error creating worktree:", e);
        await postNote(threadId, customerId, `Failed to create worktree: ${e}`);
      }
      return;
    }

    // Work on command
    if (request.toLowerCase().startsWith("work on")) {
      const session = activeSessions.get(threadId);
      if (session) {
        const workDescription = request.replace(/^work on\s*/i, "").trim();
        await postNote(threadId, customerId, `Starting work: ${workDescription}\n\nI'll post updates as I make progress.`);

        const workPrompt = buildWorkPrompt(workDescription, threadContext);
        const { result: workResult, sessionId } = await runClaude(workPrompt, session.worktreeDir, session.claudeSessionId || undefined);
        session.claudeSessionId = sessionId;

        await postNote(
          threadId,
          customerId,
          `Completed work.\n\n${workResult.substring(0, 1500)}${workResult.length > 1500 ? "..." : ""}`
        );
      } else {
        await postNote(threadId, customerId, "No active worktree for this thread. Use '@michael start worktree' first.");
      }
      return;
    }

    // Default: post Claude's response as a note
    await postNote(threadId, customerId, result);
  } catch (e) {
    console.error("[plain] Error handling @michael mention:", e);
    await postNote(threadId, customerId, `Error processing request: ${e}`);
  }
}

export async function processMichaelMention(
  threadId: string,
  noteId: string,
  noteText: string
): Promise<void> {
  const triggerId = `note-${noteId}`;
  if (processedMessages.has(triggerId)) {
    return;
  }
  processedMessages.add(triggerId);

  try {
    const thread = await getThreadWithMessages(threadId);
    if (!thread) {
      console.log(`[plain] Could not fetch thread ${threadId}`);
      return;
    }

    const customerId = thread.customer?.id;
    if (!customerId) {
      console.log(`[plain] No customer ID in thread`);
      return;
    }

    await handleMichaelMention(threadId, customerId, noteText, thread);
  } catch (e) {
    console.error(`[plain] Error processing @michael mention:`, e);
  }
}

/**
 * Route a new ticket, then fire the automation event bus.
 *
 * A no-tools Haiku call (see ticket-router.ts) routes the ticket before any
 * triage automation starts a session. Confident spam → no run, just an
 * internal note explaining the skip. A very basic ask (simple refund,
 * how-do-I) → triage runs on the router's cheaper model instead of the
 * automation's default (Fable). Everything else — including router errors —
 * fails open and fires the event on the default model as before.
 */
async function gateAndFireThreadCreated(payload: PlainWebhookPayload): Promise<void> {
  const thread = payload.payload.thread;

  const { fireAutomationsForEvent, listAutomations } = await import("../../server/automations");

  // No subscriber, no run to protect — skip the classifier call too
  const hasSubscriber = listAutomations().some(
    (a) => a.enabled && a.eventKey === "plain:thread_created"
  );
  if (!hasSubscriber) return;

  // Give the classifier the real ticket content when we can fetch it; the
  // webhook payload (title + preview) is the fallback
  let ticketContent =
    `Title: ${thread.title || "(none)"}\n` +
    `Customer: ${thread.customer?.fullName || "(unknown)"} <${thread.customer?.email?.email || "no email"}>\n` +
    `Preview: ${thread.previewText || "(none)"}`;
  try {
    const full = await getThreadWithMessages(thread.id);
    if (full) ticketContent = formatThreadContext(full, true);
  } catch {}

  const { classifyTicketRoute, getRouterConfig } = await import("./ticket-router");
  const verdict = await classifyTicketRoute(ticketContent);

  if (verdict?.route === "spam") {
    console.log(`[plain] Skipping auto-triage for thread ${thread.id} — spam: ${verdict.reason}`);
    if (thread.customer?.id) {
      await postNote(
        thread.id,
        thread.customer.id,
        `Auto-triage skipped — this ticket looks like spam.\n\nReason: ${verdict.reason}\n\nIf this is a real ticket, mention @michael or run the triage automation manually from Backstage.`,
        `**Auto-triage skipped — this ticket looks like spam.**\n\nReason: ${verdict.reason}\n\n*If this is a real ticket, mention @michael or run the triage automation manually from Backstage.*`
      );
    }
    return;
  }

  // "basic" → run triage on the router's cheaper model; "full"/no-verdict →
  // the automation's own model (fail open, never downgrade on router errors).
  const modelOverride =
    verdict?.route === "basic" ? getRouterConfig().basicModel : undefined;
  if (modelOverride) {
    console.log(
      `[plain] Routing thread ${thread.id} to ${modelOverride} — basic: ${verdict!.reason}`
    );
  }

  fireAutomationsForEvent(
    "plain:thread_created",
    JSON.stringify(
      {
        threadId: thread.id,
        title: thread.title || null,
        previewText: thread.previewText || null,
        status: thread.status,
        customer: {
          email: thread.customer?.email?.email || null,
          fullName: thread.customer?.fullName || null,
        },
      },
      null,
      2
    ),
    modelOverride ? { modelOverride } : undefined
  );
}

export async function handleWebhook(payload: PlainWebhookPayload): Promise<Response> {
  const eventType = payload.type;
  console.log(`[plain] Webhook received: ${eventType}`);

  const thread = payload.payload.thread;
  if (!thread) {
    console.log(`[plain] No thread in payload`);
    return Response.json({ ok: true });
  }

  // Publish new tickets to the automation event bus (e.g. auto-triage),
  // behind a cheap spam gate so spam never starts an expensive session.
  // Runs async — the webhook response doesn't wait for the classifier.
  if (eventType === "thread.thread_created") {
    void gateAndFireThreadCreated(payload).catch((e) =>
      console.error("[plain] thread_created gate failed:", e)
    );
  }

  // Archive triage sessions when their ticket is done
  if (eventType === "thread.thread_status_transitioned" && thread.status === "DONE") {
    const { archiveSessionsForThread } = await import("../../server/plain-archive");
    const n = archiveSessionsForThread(thread.id);
    if (n > 0) console.log(`[plain] Archived ${n} session(s) for done thread ${thread.id}`);
  }

  // Handle note_created for @michael mentions
  if (eventType === "thread.note_created" && payload.payload.note) {
    const note = payload.payload.note;
    const noteText = note.text || note.markdown || "";

    if (noteText.toLowerCase().includes("@michael")) {
      // SECURITY: Only respond to notes from support agents (user), not customers or bots
      const actorType = note.createdBy?.actorType;
      if (actorType !== "user") {
        console.log(`[plain] Ignoring @michael mention from non-user actor: ${actorType}`);
        return Response.json({ ok: true });
      }

      processMichaelMention(thread.id, note.id, noteText).catch((e) =>
        console.error("[plain] Error processing @michael mention:", e)
      );
    }

    return Response.json({ ok: true });
  }

  console.log(`[plain] Ignoring event type: ${eventType}`);
  return Response.json({ ok: true });
}
