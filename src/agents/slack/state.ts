/**
 * Shared mutable state for the Slack agent.
 *
 * Centralized here so multiple modules (handlers, queue, worktree-channels,
 * github-reviews, index) can read/write without circular imports.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackSession {
  channel: string;
  threadTs: string;
  userId: string;
  claudeSessionId: string | null;
  worktreeDir: string | null;
  branch: string | null;
  mode: "conversational" | "worktree";
  createdAt: string;
  lastActivity: string;
}

export interface PendingAnswer {
  resolve: (answer: string) => void;
  messageTs: string;
  channel: string;
  threadTs: string;
  sessionKey: string;
  timeoutId: ReturnType<typeof setTimeout>;
  questionText: string;
  header: string;
}

/** Sentinel returned to handleAskUserQuestion when the user cancels mid-modal. */
export const CANCELLED_ANSWER = "__CANCELLED__";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_DIR = `${process.env.HOME}/.slack-sessions`;
export const DEFAULT_CWD = "/home/ubuntu/projects/tella-fusion";
export const MCP_CONFIG_PATH =
  "/home/ubuntu/projects/tella-backstage/mcp-config.json";
export const GITHUB_REPO = "tellahq/tella-fusion";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export const activeSessions = new Map<string, SlackSession>();
export const processedEvents = new Set<string>();
export const pendingAnswers = new Map<string, PendingAnswer>();

export let slackTeamId = "";
export let slackBotUserId = "";
export let githubWebhooksReceived = 0;

export function setSlackTeamId(id: string) {
  slackTeamId = id;
}
export function setSlackBotUserId(id: string) {
  slackBotUserId = id;
}
export function incrementGithubWebhooks() {
  githubWebhooksReceived++;
}

// ---------------------------------------------------------------------------
// Session key helper
// ---------------------------------------------------------------------------

export function getSessionKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}-${threadTs}` : channel;
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export async function saveSession(session: SlackSession): Promise<void> {
  const key = getSessionKey(session.channel, session.threadTs);
  const sessionFile = `${SESSION_DIR}/${key}.json`;
  const data = {
    channel: session.channel,
    threadTs: session.threadTs,
    userId: session.userId,
    claudeSessionId: session.claudeSessionId,
    worktreeDir: session.worktreeDir,
    branch: session.branch,
    mode: session.mode,
    createdAt: session.createdAt,
    lastActivity: new Date().toISOString(),
  };
  await Bun.write(sessionFile, JSON.stringify(data, null, 2));
}

export async function loadSession(
  key: string
): Promise<SlackSession | null> {
  try {
    const sessionFile = `${SESSION_DIR}/${key}.json`;
    const file = Bun.file(sessionFile);
    if (await file.exists()) {
      return JSON.parse(await file.text());
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadActiveSessionsOnStartup(): Promise<void> {
  const { readdirSync } = require("fs");
  console.log("[slack] Loading active sessions from disk...");

  try {
    const files = readdirSync(SESSION_DIR).filter((f: string) =>
      f.endsWith(".json")
    );

    for (const file of files) {
      try {
        const key = file.replace(".json", "");
        const session = await loadSession(key);

        if (session && session.claudeSessionId) {
          activeSessions.set(key, session);
          console.log(`[slack] Restored session: ${key}`);
        }
      } catch (e) {
        console.error(`[slack] Error loading session ${file}:`, e);
      }
    }
  } catch {
    console.log("[slack] No active sessions to load");
  }
}
