/**
 * Linear agent session lifecycle, Claude runner, polling, and Ralph mode.
 */
import { spawn, execSync } from "child_process";
import { unlinkSync } from "fs";
import { linearEmailToGithubUsername } from "../../server/shared/user-mappings";
import {
  createAgentActivity,
  fetchPlanFromLinear,
  getIssueDetails,
  moveToStatus,
  postComment,
} from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";

const SESSION_DIR = `${process.env.HOME}/.linear-sessions`;
const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

// --- Types ---

export interface Participant {
  id: string;
  name: string;
  email: string | null;
}

interface RalphStatus {
  iteration: number;
  max: number;
  status: "running" | "idle" | "complete" | "max_iterations";
  current_tool?: string;
  tool_time?: string;
  total_cost_usd: number;
  started?: string;
}

export interface ActiveSession {
  branch: string;
  claudeSessionId: string | null;
  accessToken: string;
  issueTitle: string;
  issueIdentifier: string;
  issueId: string;
  issueDescription: string;
  issueUrl: string;
  teamId: string;
  worktreeDir: string;
  linearSessionId: string;
  lastMessageUuid: string | null;
  pollInterval?: ReturnType<typeof setInterval>;
  claudeProcess?: ReturnType<typeof Bun.spawn>;
  isPlanning: boolean;
  planningConversation: Array<{ role: "michael" | "user"; content: string; timestamp: string }>;
  awaitingImplementationConfirmation: boolean;
  awaitingInitialDirection: boolean;
  isRalphMode: boolean;
  ralphProcess?: ReturnType<typeof Bun.spawn>;
  ralphPollInterval?: ReturnType<typeof setInterval>;
  participants: Participant[];
  lastActiveUser: Participant | null;
  issueCreator: Participant | null;
}

/** In-memory active sessions: linearSessionId -> ActiveSession */
export const activeSessions = new Map<string, ActiveSession>();

/** Dedup set for webhook sessions */
export const processedSessions = new Set<string>();

/** Track sent message UUIDs to avoid duplicates */
const sentMessageUuids = new Set<string>();

// --- Utilities ---

export function extractPrUrl(result: string): string | null {
  const prUrlMatch = result.match(/https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/);
  return prUrlMatch ? prUrlMatch[0] : null;
}

export function formatConversationHistory(
  conversation: Array<{ role: "michael" | "user"; content: string; timestamp: string }>
): string {
  if (conversation.length === 0) return "";
  return conversation
    .map((msg) => `**${msg.role === "michael" ? "Michael" : "User"}:** ${msg.content}`)
    .join("\n\n");
}

export function buildParticipantSections(
  participants: Participant[],
  lastActiveUser: Participant | null
): { participantsSection: string; coAuthorInstruction: string } {
  let participantsSection = "";
  let coAuthorInstruction = "";

  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsSection = `\n**Requested by:** ${names} (via Linear)\n`;
  }

  if (lastActiveUser) {
    const email = lastActiveUser.email || `${lastActiveUser.id}@users.linear.app`;
    coAuthorInstruction = `IMPORTANT: When creating commits, include this Co-Authored-By line:
Co-Authored-By: ${lastActiveUser.name} <${email}>`;
  }

  return { participantsSection, coAuthorInstruction };
}

// --- Branch & Worktree ---

export async function generateBranchName(title: string, issueIdentifier?: string): Promise<string> {
  const proc = Bun.spawn([
    "/home/ubuntu/.local/bin/claude",
    "-p",
    `Generate a 1-2 word branch name (lowercase, hyphen-separated, no special chars) for this ticket: "${title}". Output ONLY the branch name, nothing else.`,
  ]);
  const output = await new Response(proc.stdout).text();
  let branch = output
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30);
  branch = branch || "task";

  if (issueIdentifier) {
    const suffix = issueIdentifier.toLowerCase().replace(/[^a-z0-9]/g, "");
    branch = `${branch}-${suffix}`;
  }

  return branch;
}

export function createWorktree(
  branch: string,
  ticketId: string,
  title: string,
  description: string,
  url: string
): string {
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
      `--url=${url}`,
    ],
    { stdio: "inherit", timeout: 120000 }
  );

  if (result.status !== 0) {
    throw new Error(`wt new-linear exited with code ${result.status}`);
  }
  console.log(`[linear] Created worktree: ${branch}`);
  return worktreeDir;
}

// --- Session persistence ---

export async function saveSessionInfo(
  branch: string,
  claudeSessionId: string | null,
  issueIdentifier: string,
  issueTitle: string,
  worktreeDir: string,
  linearSessionId?: string,
  isRalphMode?: boolean,
  awaitingImplementationConfirmation?: boolean,
  issueId?: string,
  issueUrl?: string,
  participants?: Participant[],
  lastActiveUser?: Participant | null,
  awaitingInitialDirection?: boolean,
  issueCreator?: Participant | null
): Promise<void> {
  const sessionFile = `${SESSION_DIR}/${branch}.json`;

  let existing: Record<string, unknown> = {};
  try {
    const existingFile = Bun.file(sessionFile);
    if (await existingFile.exists()) {
      existing = JSON.parse(await existingFile.text());
    }
  } catch {
    // start fresh
  }

  const data = {
    branch,
    claudeSessionId,
    issueIdentifier,
    issueTitle,
    worktreeDir,
    linearSessionId,
    isRalphMode: isRalphMode !== undefined ? isRalphMode : (existing.isRalphMode || false),
    awaitingImplementationConfirmation:
      awaitingImplementationConfirmation !== undefined
        ? awaitingImplementationConfirmation
        : (existing.awaitingImplementationConfirmation || false),
    awaitingInitialDirection:
      awaitingInitialDirection !== undefined
        ? awaitingInitialDirection
        : (existing.awaitingInitialDirection || false),
    issueId: issueId || existing.issueId || "",
    issueUrl: issueUrl || existing.issueUrl || "",
    participants: participants !== undefined ? participants : (existing.participants || []),
    lastActiveUser: lastActiveUser !== undefined ? lastActiveUser : (existing.lastActiveUser || null),
    issueCreator: issueCreator !== undefined ? issueCreator : (existing.issueCreator || null),
    updatedAt: new Date().toISOString(),
  };
  await Bun.write(sessionFile, JSON.stringify(data, null, 2));
}

export async function loadSessionInfo(branch: string): Promise<{
  claudeSessionId: string | null;
  issueIdentifier: string;
  issueTitle?: string;
  worktreeDir: string;
  linearSessionId?: string;
  isRalphMode?: boolean;
  awaitingImplementationConfirmation?: boolean;
  awaitingInitialDirection?: boolean;
  issueId?: string;
  issueUrl?: string;
  participants?: Participant[];
  lastActiveUser?: Participant | null;
  issueCreator?: Participant | null;
} | null> {
  try {
    const file = Bun.file(`${SESSION_DIR}/${branch}.json`);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
    return null;
  } catch {
    return null;
  }
}

export function deleteSessionFile(branch: string): void {
  try {
    unlinkSync(`${SESSION_DIR}/${branch}.json`);
    console.log(`[linear] Deleted session file: ${SESSION_DIR}/${branch}.json`);
  } catch {
    // File might not exist
  }
}

export function deleteWorktree(branch: string): void {
  spawn("/home/ubuntu/bin/wt", ["delete", branch], { stdio: "inherit" });
  console.log(`[linear] Deleted worktree: ${branch}`);
}

// --- Claude session file ---

function getClaudeSessionFile(worktreeDir: string, claudeSessionId: string): string {
  const projectFolder = worktreeDir.replace(/\//g, "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/${projectFolder}/${claudeSessionId}.jsonl`;
}

export async function getLastMessageUuid(worktreeDir: string, claudeSessionId: string): Promise<string | null> {
  const sessionFile = getClaudeSessionFile(worktreeDir, claudeSessionId);
  try {
    const file = Bun.file(sessionFile);
    if (!(await file.exists())) return null;

    const content = await file.text();
    const lines = content.trim().split("\n");

    let lastUuid: string | null = null;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.uuid) {
          lastUuid = msg.uuid;
        }
      } catch {}
    }
    return lastUuid;
  } catch {
    return null;
  }
}

// --- Claude headless runner ---

export async function runClaudeHeadless(
  worktreeDir: string,
  prompt: string,
  linearSessionId: string,
  accessToken: string,
  resumeClaudeId?: string,
  session?: ActiveSession
): Promise<{ result: string; claudeSessionId: string }> {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (resumeClaudeId) {
    args.push("--resume", resumeClaudeId);
  }

  console.log(`[linear] Running Claude headless in ${worktreeDir}`);

  const proc = Bun.spawn(["/home/ubuntu/.local/bin/claude", ...args], {
    cwd: worktreeDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: "/home/ubuntu/.cargo/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/home/ubuntu/bin:/home/ubuntu/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/home/ubuntu",
    },
  });

  if (session) {
    session.claudeProcess = proc;
  }

  let result = "";
  let claudeSessionId = "";
  let buffer = "";
  let lastThoughtTime = 0;
  const THOUGHT_THROTTLE_MS = 5000;

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);

          if (data.type === "assistant" && data.message?.content) {
            const text = data.message.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");

            if (text && text.length > 20) {
              const now = Date.now();
              if (now - lastThoughtTime > THOUGHT_THROTTLE_MS) {
                lastThoughtTime = now;
                createAgentActivity(accessToken, linearSessionId, {
                  type: "thought",
                  body: text.substring(0, 2000),
                }).catch((e) => console.error("[linear] Failed to send thought:", e));
              }
            }
          }

          if (data.type === "result") {
            result = data.result || "";
            claudeSessionId = data.session_id || "";
            console.log(`[linear] Claude finished. Session ID: ${claudeSessionId}`);
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }

  await proc.exited;

  if (session) {
    session.claudeProcess = undefined;
  }

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`[linear] Claude exited with code ${proc.exitCode}: ${stderr}`);
  }

  return { result, claudeSessionId };
}

// --- Session polling ---

async function pollClaudeSession(session: ActiveSession): Promise<void> {
  if (!session.claudeSessionId) return;

  const sessionFile = getClaudeSessionFile(session.worktreeDir, session.claudeSessionId);

  try {
    const file = Bun.file(sessionFile);
    if (!(await file.exists())) return;

    const content = await file.text();
    const lines = content.trim().split("\n");

    let foundLast = session.lastMessageUuid === null;
    const newMessages: Array<{ uuid: string; text: string }> = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (!foundLast) {
          if (msg.uuid === session.lastMessageUuid) foundLast = true;
          continue;
        }
        if (msg.type === "assistant" && msg.message?.content) {
          const textContent = msg.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (textContent && textContent.length > 20) {
            newMessages.push({ uuid: msg.uuid, text: textContent });
          }
        }
      } catch {}
    }

    const unseenMessages = newMessages.filter((m) => !sentMessageUuids.has(m.uuid));
    if (unseenMessages.length > 0) {
      const lastMsg = unseenMessages[unseenMessages.length - 1];
      sentMessageUuids.add(lastMsg.uuid);

      await createAgentActivity(session.accessToken, session.linearSessionId, {
        type: "thought",
        body: lastMsg.text,
      });

      session.lastMessageUuid = lastMsg.uuid;
      for (const msg of unseenMessages) {
        sentMessageUuids.add(msg.uuid);
      }
    }
  } catch (e) {
    console.error(`[linear] Error polling Claude session:`, e);
  }
}

export function startSessionPolling(session: ActiveSession): void {
  if (session.pollInterval) clearInterval(session.pollInterval);
  console.log(`[linear] Starting session polling for ${session.branch}`);
  session.pollInterval = setInterval(() => pollClaudeSession(session), 5000);
}

export function stopSessionPolling(session: ActiveSession): void {
  if (session.pollInterval) {
    console.log(`[linear] Stopping session polling for ${session.branch}`);
    clearInterval(session.pollInterval);
    session.pollInterval = undefined;
  }
}

// --- PR creation ---

export async function createPrWithAttribution(
  worktreeDir: string,
  issueIdentifier: string,
  issueUrl: string,
  issueTitle: string,
  participants: Participant[],
  reviewer?: string | null
): Promise<string | null> {
  let participantsLine = "";
  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsLine =
      participants.length === 1
        ? `**Requested by:** ${names} (via Linear)`
        : `**Participants:** ${names} (via Linear)`;
  }

  const prBody = `## Summary
Implements ${issueIdentifier}: ${issueTitle}

${issueUrl}
${participantsLine ? `\n${participantsLine}\n` : ""}
## Test plan
- [ ] Verify implementation meets acceptance criteria

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;

  try {
    const args = ["gh", "pr", "create", "--title", `${issueIdentifier}: ${issueTitle}`, "--body", prBody];
    if (reviewer) {
      args.push("--reviewer", reviewer);
    }
    const proc = Bun.spawn(args, {
      cwd: worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: "/home/ubuntu/.cargo/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/home/ubuntu/bin:/home/ubuntu/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/home/ubuntu",
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[linear] Failed to create PR: ${stderr}`);
      return null;
    }

    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    return urlMatch ? urlMatch[0] : output.trim();
  } catch (e) {
    console.error(`[linear] Error creating PR: ${e}`);
    return null;
  }
}

// --- Ralph mode ---

export async function startRalphLoop(
  session: ActiveSession,
  accessToken: string,
  linearSessionId: string
): Promise<void> {
  console.log(`[linear] Starting Ralph loop for ${session.issueIdentifier}`);

  await createAgentActivity(accessToken, linearSessionId, {
    type: "thought",
    body: "Starting Ralph iterative implementation loop...",
  });

  await moveToStatus(accessToken, session.issueId, session.teamId, "In Progress");

  const plan = await fetchPlanFromLinear(accessToken, session.issueId);
  if (!plan) {
    await createAgentActivity(accessToken, linearSessionId, {
      type: "response",
      body: "Error: Could not find implementation plan in issue comments.",
    });
    return;
  }

  const planFile = `PLAN-${session.issueIdentifier}.md`;
  const planPath = `${session.worktreeDir}/${planFile}`;
  await Bun.write(planPath, plan);

  const fullPath = `/home/ubuntu/.nvm/versions/node/v20.20.0/bin:${process.env.PATH}`;
  try {
    execSync(`just ralph import ${planFile}`, {
      cwd: session.worktreeDir,
      encoding: "utf-8",
      env: { ...process.env, PATH: fullPath },
    });
  } catch (e) {
    console.error(`[linear] Ralph import failed:`, e);
    await createAgentActivity(accessToken, linearSessionId, {
      type: "response",
      body: `Error: Ralph import failed - ${e}`,
    });
    return;
  }

  let prdContent = "";
  try {
    const prdFile = Bun.file(`${session.worktreeDir}/prd.json`);
    if (await prdFile.exists()) {
      prdContent = await prdFile.text();
    }
  } catch {}

  await createAgentActivity(accessToken, linearSessionId, {
    type: "thought",
    body: "PRD generated. Starting iterative loop...",
  });

  const prdMessage = prdContent
    ? `🔄 **PRD generated. Starting iterative loop...**\n\n\`\`\`json\n${prdContent}\`\`\``
    : "🔄 PRD generated. Starting iterative loop...";
  await postComment(accessToken, session.issueId, prdMessage);

  session.ralphProcess = Bun.spawn(["just", "ralph", "loop"], {
    cwd: session.worktreeDir,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      PATH: "/home/ubuntu/.cargo/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/home/ubuntu/bin:/home/ubuntu/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/home/ubuntu",
    },
  });
  console.log(`[linear] Ralph loop started (pid: ${session.ralphProcess.pid})`);

  await saveSessionInfo(
    session.branch,
    session.claudeSessionId,
    session.issueIdentifier,
    session.issueTitle,
    session.worktreeDir,
    session.linearSessionId,
    true,
    false,
    session.issueId,
    session.issueUrl,
    session.participants,
    session.lastActiveUser
  );

  startRalphPolling(session, accessToken, linearSessionId);
}

export function startRalphPolling(
  session: ActiveSession,
  accessToken: string,
  linearSessionId: string
): void {
  console.log(`[linear] Starting Ralph polling for ${session.issueIdentifier || session.branch}`);
  let lastPostedIteration = 0;
  let lastStatus = "";

  session.ralphPollInterval = setInterval(async () => {
    const statusPath = `${session.worktreeDir}/status.json`;
    const prdPath = `${session.worktreeDir}/prd.json`;

    try {
      const statusFile = Bun.file(statusPath);
      if (!(await statusFile.exists())) return;

      const status: RalphStatus = JSON.parse(await statusFile.text());

      if (status.status === "complete" || status.status === "max_iterations") {
        await handleRalphCompletion(session, accessToken, linearSessionId, status);
        return;
      }

      const shouldPost = status.iteration !== lastPostedIteration || status.status !== lastStatus;
      if (!shouldPost) return;

      lastPostedIteration = status.iteration;
      lastStatus = status.status;

      let message = `**Ralph** iteration ${status.iteration}/${status.max}`;

      const prdFile = Bun.file(prdPath);
      if (await prdFile.exists()) {
        try {
          const prd = JSON.parse(await prdFile.text());
          const completed = prd.filter((t: { passes?: boolean }) => t.passes);
          const remaining = prd.filter((t: { passes?: boolean }) => !t.passes);

          if (completed.length > 0 || remaining.length > 0) {
            message += ` (${completed.length}/${prd.length} tasks)`;
          }
          if (completed.length > 0) {
            message += `\n\n${completed.map((t: { id: string }) => `✓ ${t.id}`).join("\n")}`;
          }
          if (remaining.length > 0) {
            message += `\n\n${remaining.map((t: { id: string }) => `○ ${t.id}`).join("\n")}`;
          }
        } catch {}
      }

      if (status.current_tool) {
        message += `\n\n_${status.current_tool}_`;
      }

      await createAgentActivity(accessToken, linearSessionId, {
        type: "thought",
        body: message,
      });
    } catch (e) {
      console.error(`[linear] Error polling Ralph status:`, e);
    }
  }, 10000);
}

async function handleRalphCompletion(
  session: ActiveSession,
  accessToken: string,
  linearSessionId: string,
  status: RalphStatus
): Promise<void> {
  console.log(`[linear] Ralph completed for ${session.issueIdentifier}: ${status.status}`);

  if (session.ralphPollInterval) {
    clearInterval(session.ralphPollInterval);
    session.ralphPollInterval = undefined;
  }

  if (session.ralphProcess) {
    try {
      await session.ralphProcess.exited;
    } catch {}
    session.ralphProcess = undefined;
  }

  const isSuccess = status.status === "complete";
  const message = isSuccess
    ? `Ralph completed all tasks after ${status.iteration} iterations!`
    : `Ralph reached max iterations (${status.max}).`;

  await createAgentActivity(accessToken, linearSessionId, {
    type: "thought",
    body: message,
  });

  try {
    let issueTitle = session.issueTitle;
    let issueUrl = session.issueUrl;
    if (!issueTitle || !issueUrl) {
      if (session.issueId) {
        const details = await getIssueDetails(accessToken, session.issueId);
        issueTitle = details.title;
        issueUrl = details.url;
      }
    }

    const prTitle = `[${session.issueIdentifier}] ${issueTitle}`;

    let summary = "";
    try {
      const progressFile = Bun.file(`${session.worktreeDir}/progress.json`);
      if (await progressFile.exists()) {
        const progress = JSON.parse(await progressFile.text());
        if (Array.isArray(progress) && progress.length > 0) {
          summary = progress
            .map((p: { task_id: string; notes: string }) => `- **${p.task_id}**: ${p.notes}`)
            .join("\n");
        }
      }
    } catch {}

    let participantsLine = "";
    if (session.participants.length > 0) {
      const names = session.participants.map((p) => p.name);
      participantsLine =
        session.participants.length === 1
          ? `**Requested by:** ${names[0]} (via Linear)`
          : `**Participants:** ${names.join(", ")} (via Linear)`;
    }

    const prBody = `Implemented by Ralph (${status.iteration} iterations)

## Summary
${summary || "No progress details available."}

${participantsLine}

Linear: ${issueUrl}`;

    execSync("just ralph clean", { cwd: session.worktreeDir, encoding: "utf-8" });
    execSync("rm -f PLAN-*.md", { cwd: session.worktreeDir, encoding: "utf-8" });

    let commitMsg = "Ralph implementation";
    const coAuthor = session.lastActiveUser;
    if (coAuthor) {
      const email = coAuthor.email || `${coAuthor.id}@users.linear.app`;
      commitMsg += `\n\nCo-Authored-By: ${coAuthor.name} <${email}>`;
    }

    const commitMsgFile = `${session.worktreeDir}/.commit-msg`;
    await Bun.write(commitMsgFile, commitMsg);

    execSync(
      "git add -A && git diff --cached --quiet || git commit -F .commit-msg && rm -f .commit-msg && git push -u origin " +
        session.branch,
      { cwd: session.worktreeDir, encoding: "utf-8" }
    );

    await Bun.write(`${session.worktreeDir}/.pr-body.md`, prBody);

    const reviewerGithub = linearEmailToGithubUsername(session.issueCreator?.email || null);
    const reviewerFlag = reviewerGithub ? ` --reviewer ${reviewerGithub}` : "";
    const prResult = execSync(
      `gh pr create --title "${prTitle}" --body-file .pr-body.md${reviewerFlag}`,
      { cwd: session.worktreeDir, encoding: "utf-8" }
    );

    execSync("rm -f .pr-body.md", { cwd: session.worktreeDir });

    const prUrl = prResult.trim();
    console.log(`[linear] Created PR: ${prUrl}`);

    const completionMessage = isSuccess
      ? `**Implementation complete!**\n\n${summary ? `## Summary\n${summary}\n\n` : ""}PR: ${prUrl}`
      : `Reached max iterations. PR: ${prUrl}`;

    await createAgentActivity(accessToken, linearSessionId, {
      type: "response",
      body: completionMessage,
    });
  } catch (e) {
    console.error(`[linear] Error creating PR:`, e);
    await createAgentActivity(accessToken, linearSessionId, {
      type: "response",
      body: `${message}\n\nFailed to create PR: ${e}`,
    });
  }

  session.isRalphMode = false;

  await saveSessionInfo(
    session.branch,
    session.claudeSessionId,
    session.issueIdentifier,
    session.issueTitle,
    session.worktreeDir,
    session.linearSessionId,
    false,
    undefined,
    session.issueId,
    session.issueUrl,
    session.participants,
    session.lastActiveUser
  );
}

// --- Startup ---

export async function loadActiveSessionsOnStartup(tokens: LinearTokens): Promise<void> {
  console.log("[linear] Loading active sessions from disk...");

  try {
    const { readdirSync } = await import("fs");
    const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const branch = file.replace(".json", "");
        const sessionData = await loadSessionInfo(branch);

        if (
          sessionData &&
          sessionData.linearSessionId &&
          (sessionData.claudeSessionId || sessionData.awaitingInitialDirection)
        ) {
          const orgId = Object.keys(tokens)[0];
          if (!orgId) continue;

          const accessToken = await getValidToken(orgId, tokens);
          if (!accessToken) continue;

          const lastMessageUuid = sessionData.claudeSessionId
            ? await getLastMessageUuid(sessionData.worktreeDir, sessionData.claudeSessionId)
            : null;

          const session: ActiveSession = {
            branch,
            claudeSessionId: sessionData.claudeSessionId,
            accessToken,
            issueTitle: sessionData.issueTitle || "",
            issueIdentifier: sessionData.issueIdentifier,
            issueId: sessionData.issueId || "",
            issueDescription: "",
            issueUrl: sessionData.issueUrl || "",
            teamId: "",
            worktreeDir: sessionData.worktreeDir,
            linearSessionId: sessionData.linearSessionId,
            lastMessageUuid,
            isPlanning: false,
            planningConversation: [],
            awaitingImplementationConfirmation: sessionData.awaitingImplementationConfirmation || false,
            awaitingInitialDirection: sessionData.awaitingInitialDirection || false,
            isRalphMode: sessionData.isRalphMode || false,
            participants: sessionData.participants || [],
            lastActiveUser: sessionData.lastActiveUser || null,
            issueCreator: sessionData.issueCreator || null,
          };

          activeSessions.set(sessionData.linearSessionId, session);

          console.log(
            `[linear] Restored session: ${branch} (Claude: ${sessionData.claudeSessionId}, Linear: ${sessionData.linearSessionId}, Ralph: ${session.isRalphMode})`
          );

          if (session.awaitingInitialDirection) {
            // No polling needed yet
          } else if (session.isRalphMode) {
            const statusPath = `${sessionData.worktreeDir}/status.json`;
            let needsRestart = true;
            try {
              const statusFile = Bun.file(statusPath);
              if (await statusFile.exists()) {
                const st = JSON.parse(await statusFile.text());
                if (st.status === "complete" || st.status === "max_iterations") {
                  needsRestart = false;
                }
              }
            } catch {}

            if (needsRestart) {
              session.ralphProcess = Bun.spawn(["just", "ralph", "loop"], {
                cwd: sessionData.worktreeDir,
                stdout: "ignore",
                stderr: "ignore",
                env: {
                  ...process.env,
                  PATH: "/home/ubuntu/.cargo/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/home/ubuntu/bin:/home/ubuntu/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                  HOME: "/home/ubuntu",
                },
              });
            }

            startRalphPolling(session, accessToken, sessionData.linearSessionId);
          } else {
            startSessionPolling(session);
          }
        }
      } catch (e) {
        console.error(`[linear] Error loading session ${file}:`, e);
      }
    }
  } catch {
    console.log("[linear] No active sessions to load");
  }
}
