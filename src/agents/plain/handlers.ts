/**
 * Plain agent webhook and mention handlers.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import mcpConfig from "../../../mcp-config.json";
import {
  getThreadWithMessages,
  postNote,
  sendCustomerReply,
  formatThreadContext,
  cleanDraftText,
  createLinearIssue,
  plain,
} from "./api";
import { buildMentionPrompt, buildWorkPrompt } from "./prompts";

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
  resumeSessionId?: string
): Promise<{ result: string; sessionId: string }> {
  console.log(`[plain] Running Claude SDK in ${cwd}${resumeSessionId ? ` (resuming ${resumeSessionId})` : ""}`);

  let result = "";
  let sessionId = resumeSessionId || "";

  try {
    const q = query({
      prompt,
      options: {
        resume: resumeSessionId || undefined,
        cwd,
        allowedTools: [
          "Bash", "Read", "Edit", "Write", "Grep", "Glob",
          "Task", "TaskOutput", "WebFetch", "WebSearch",
          "NotebookEdit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
          "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool", "ToolSearch",
        ],
        canUseTool: async (_toolName: string, input: unknown) => {
          return { behavior: "allow" as const, updatedInput: input };
        },
        mcpServers: mcpConfig.mcpServers as any,
        strictMcpConfig: true,
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
            statusDetail: "WAITING_FOR_CUSTOMER",
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
            await postNote(threadId, customerId, `Failed to create Linear issue. LINEAR_API_KEY may not be configured.`);
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
          await postNote(threadId, customerId, "Failed to create Linear issue for worktree. Check LINEAR_API_KEY.");
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

export async function handleWebhook(payload: PlainWebhookPayload): Promise<Response> {
  const eventType = payload.type;
  console.log(`[plain] Webhook received: ${eventType}`);

  const thread = payload.payload.thread;
  if (!thread) {
    console.log(`[plain] No thread in payload`);
    return Response.json({ ok: true });
  }

  // Publish new tickets to the automation event bus (e.g. auto-triage)
  if (eventType === "thread.thread_created") {
    const { fireAutomationsForEvent } = await import("../../server/automations");
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
      )
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
