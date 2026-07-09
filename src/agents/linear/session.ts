/**
 * Linear agent session lifecycle, Claude runner, polling, and Ralph mode.
 */
import { envAlias } from "../../server/rename-compat";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { runAgent, cancelAgentRun } from "../../server/agent-runner";
import { productName } from "../../server/config";
import { getDefaultModel, toOpencodeModel } from "../../server/models";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { worktreePathFor } from "../../server/worktree";
import { spawn, spawnSync, execSync } from "child_process";
import { unlinkSync } from "fs";
import { linearEmailToGithubUsername, gitIdentityFor, gitIdentityEnv } from "../../server/shared/user-mappings";
import {
  createAgentActivity,
  fetchPlanFromLinear,
  getIssueDetails,
  moveToStatus,
  postComment,
  updateAgentSession,
  type PlanStep,
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
  abortController?: AbortController;
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
  /** Model id for this session's runs (from the session file); unset = default. */
  model?: string;
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

export function generateBranchName(title: string, issueIdentifier?: string): string {
  // Heuristic: take first 1-2 words from title, lowercased, hyphen-separated, no special chars
  // Avoids a full Haiku query just for a branch name.
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .split(/\s+/) // Split on whitespace
    .filter((w) => w.length > 0) // Remove empty strings
    .slice(0, 2) // Take first 2 words
    .join("-") // Hyphenate
    .slice(0, 30); // Max 30 chars

  let branch = words || "task";

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
  const worktreeDir = worktreePathFor(branch);

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
    model: existing.model || undefined,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(sessionFile, data);
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
  model?: string;
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

// --- Action activity streaming ---

/** Base URL of the Michael web UI, linked from Linear sessions. */
export const MICHAEL_UI_BASE =
  envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE") ||
  "https://michael.taila5d766.ts.net/backstage";

export function michaelSessionUrl(branch: string): string {
  return `${MICHAEL_UI_BASE}/session/${encodeURIComponent(`linear-${branch}`)}`;
}

/** Compact action row for a tool call: { action: "Read", parameter: "src/foo.ts" }. */
function summarizeAction(name: string, input: any): { action: string; parameter: string } {
  const inp = input || {};
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    return { action: mcp[1], parameter: `${mcp[2]} ${clip(JSON.stringify(inp))}`.trim() };
  }
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return { action: name, parameter: inp.file_path || "" };
    case "Bash":
      return { action: "Ran", parameter: clip((inp.command || "").split("\n")[0]) };
    case "Grep":
      return { action: "Searched", parameter: clip(`${inp.pattern || ""} ${inp.path || inp.glob || ""}`) };
    case "Glob":
      return { action: "Globbed", parameter: clip(`${inp.pattern || ""} ${inp.path || ""}`) };
    case "Task":
    case "Agent":
      return { action: "Spawned agent", parameter: clip(inp.description || inp.subagent_type || "") };
    case "WebFetch":
      return { action: "Fetched", parameter: clip(inp.url || "") };
    case "WebSearch":
      return { action: "Searched web", parameter: clip(inp.query || "") };
    case "Skill":
      return { action: "Skill", parameter: clip(inp.skill || "") };
    default:
      return { action: name, parameter: clip(JSON.stringify(inp)) };
  }
}

function clip(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const ACTION_MIN_GAP_MS = 2000;

/**
 * Coalescing sender for action activities: tool bursts post at most one
 * activity per ACTION_MIN_GAP_MS (latest wins, trailing flush) so a busy run
 * doesn't flood the Linear timeline or the API. The full log stays in the
 * Michael UI; this is a progress feed.
 */
function makeActionStreamer(accessToken: string, linearSessionId: string) {
  let lastSent = 0;
  let pending: { action: string; parameter: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const post = (a: { action: string; parameter: string }) => {
    createAgentActivity(accessToken, linearSessionId, { type: "action", ...a })
      .catch((e) => console.error("[linear] Failed to send action:", e));
  };

  return {
    send(toolName: string, input: unknown) {
      const a = summarizeAction(toolName, input);
      const now = Date.now();
      if (now - lastSent >= ACTION_MIN_GAP_MS) {
        lastSent = now;
        post(a);
        return;
      }
      pending = a;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) {
            lastSent = Date.now();
            post(pending);
            pending = null;
          }
        }, ACTION_MIN_GAP_MS - (now - lastSent));
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// --- Headless agent runner (opencode engine) ---

export async function runAgentHeadless(
  worktreeDir: string,
  prompt: string,
  linearSessionId: string,
  accessToken: string,
  resumeClaudeId?: string,
  session?: ActiveSession
): Promise<{ result: string; claudeSessionId: string }> {
  console.log(`[linear] Running agent in ${worktreeDir}${resumeClaudeId ? ` (resuming ${resumeClaudeId})` : ""}`);

  // Attribute commits this run makes to the Linear issue creator.
  const commitAuthor = gitIdentityFor(session?.issueCreator?.email);

  // Kept as the loop's stop signal (linear/index.ts + handlers abort it):
  // aborting hard-cancels the engine run by its session id and exits the loop.
  const abortController = new AbortController();
  if (session) {
    session.abortController = abortController;
  }

  let result = "";
  let claudeSessionId = resumeClaudeId || "";
  let lastThoughtTime = 0;
  const THOUGHT_THROTTLE_MS = 5000;
  const actions = makeActionStreamer(accessToken, linearSessionId);

  // The issue actor (last prompting user, else the issue creator): gates
  // per-user `allowedUsers` MCP servers and drives the personal-first
  // subscription pick inside the engine. Account rotation and usage-limit
  // model fallback are runAgent's job now — no rotation loop here.
  const actorEmail =
    session?.lastActiveUser?.email || session?.issueCreator?.email || undefined;

  abortController.signal.addEventListener("abort", () => {
    cancelAgentRun(claudeSessionId);
  });

  try {
    for await (const event of runAgent({
      prompt,
      sessionId: claudeSessionId || undefined,
      cwd: worktreeDir,
      mode: "code",
      model: toOpencodeModel(session?.model || getDefaultModel()),
      user: actorEmail,
      author: commitAuthor,
      // Kind-only journal: gate marker for the opencode engine, no crash
      // journal — this loop tracks its own engine session ids per Linear
      // session and re-drives turns from Linear events.
      journal: { kind: "linear" },
      // Money-moving Stripe tools need the per-call human confirmation the
      // interactive runner provides; this path has no approval card, so they
      // are stripped from the tool list with this guidance.
      deniedTools: Object.fromEntries(
        Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [
          name,
          `This Stripe action requires human confirmation — open this session in ${productName()} and retry there; the approval card will appear in that UI.`,
        ])
      ),
    })) {
      if (abortController.signal.aborted) break;

      if (event.type === "init") {
        claudeSessionId = event.sessionId || claudeSessionId;
      }

      // Stream tool calls (coalesced actions) and thoughts (throttled;
      // text_chunk carries whole completed text parts) to Linear.
      if (event.type === "tool_use" && event.toolName) {
        actions.send(event.toolName, event.toolInput);
      }
      if (event.type === "text_chunk" && event.text && event.text.length > 20) {
        const now = Date.now();
        if (now - lastThoughtTime > THOUGHT_THROTTLE_MS) {
          lastThoughtTime = now;
          createAgentActivity(accessToken, linearSessionId, {
            type: "thought",
            body: event.text.substring(0, 2000),
          }).catch((e) => console.error("[linear] Failed to send thought:", e));
        }
      }
      if (event.type === "model_switch") {
        createAgentActivity(accessToken, linearSessionId, {
          type: "thought",
          body: `${event.fromModel} is out of usage — continuing this turn on ${event.toModel}. Worktree state carries over.`,
        }).catch(() => {});
      }

      if (event.type === "done") {
        claudeSessionId = event.sessionId || claudeSessionId;
        result = event.result || "";
        console.log(`[linear] Agent finished. Session ID: ${claudeSessionId}`);
      }
      if (event.type === "error") {
        result = `Error: ${event.content || "Unknown"}`;
      }
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      console.error(`[linear] agent run error:`, e);
      result = `Error: ${e.message || String(e)}`;
    }
  }

  if (session) {
    session.abortController = undefined;
  }
  actions.stop();
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

/** Map a Ralph prd.json to Linear's session plan panel. Empty plans are rejected by the API. */
function ralphPlanFromPrd(prd: any, currentTaskId?: string): PlanStep[] {
  if (!Array.isArray(prd)) return [];
  return prd.map((t: any) => ({
    content: clip(String(t.title || t.description || t.id || "task"), 200),
    status: t.passes ? "completed" : t.id === currentTaskId ? "inProgress" : "pending",
  }));
}

async function syncRalphPlan(session: ActiveSession, accessToken: string, linearSessionId: string): Promise<void> {
  try {
    const prdFile = Bun.file(`${session.worktreeDir}/prd.json`);
    if (!(await prdFile.exists())) return;
    const plan = ralphPlanFromPrd(JSON.parse(await prdFile.text()));
    if (plan.length > 0) {
      await updateAgentSession(accessToken, linearSessionId, { plan });
    }
  } catch (e) {
    console.error("[linear] Failed to sync Ralph plan:", e);
  }
}

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
      type: "error",
      body: "Could not find implementation plan in issue comments.",
    });
    return;
  }

  const planFile = `PLAN-${session.issueIdentifier}.md`;
  const planPath = `${session.worktreeDir}/${planFile}`;
  await Bun.write(planPath, plan);

  const fullPath = `/home/ubuntu/.nvm/versions/node/v20.20.0/bin:${process.env.PATH}`;
  try {
    // args array, not a shell string — planFile embeds the issue identifier,
    // which must never be interpolated into a shell command.
    const importResult = spawnSync("just", ["ralph", "import", planFile], {
      cwd: session.worktreeDir,
      encoding: "utf-8",
      env: { ...process.env, PATH: fullPath },
    });
    if (importResult.status !== 0) {
      throw new Error(
        importResult.stderr?.trim() ||
          importResult.stdout?.trim() ||
          `just ralph import exited with code ${importResult.status}`
      );
    }
  } catch (e) {
    console.error(`[linear] Ralph import failed:`, e);
    await createAgentActivity(accessToken, linearSessionId, {
      type: "error",
      body: `Ralph import failed - ${e}`,
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

  // Publish the task list to the session's plan panel
  await syncRalphPlan(session, accessToken, linearSessionId);

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

      // Task statuses live in the session's plan panel; the thought is a
      // compact ephemeral ticker that the next update replaces.
      await syncRalphPlan(session, accessToken, linearSessionId);

      let message = `**Ralph** iteration ${status.iteration}/${status.max}`;
      const prdFile = Bun.file(prdPath);
      if (await prdFile.exists()) {
        try {
          const prd = JSON.parse(await prdFile.text());
          const completed = prd.filter((t: { passes?: boolean }) => t.passes);
          message += ` (${completed.length}/${prd.length} tasks)`;
        } catch {}
      }
      if (status.current_tool) {
        message += `\n\n_${status.current_tool}_`;
      }

      await createAgentActivity(
        accessToken,
        linearSessionId,
        { type: "thought", body: message },
        true
      );
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

  // Final plan-panel state before the summary lands
  await syncRalphPlan(session, accessToken, linearSessionId);

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
      type: "error",
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
