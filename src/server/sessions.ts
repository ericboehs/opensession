import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { existsSync } from "fs";
import { slackIdToFirstName } from "./shared/user-mappings";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  BackstageSessionFile,
} from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const SLACK_SESSIONS_DIR = `${HOME}/.slack-sessions`;
const LINEAR_SESSIONS_DIR = `${HOME}/.linear-sessions`;
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const BACKSTAGE_SESSIONS_DIR = `${HOME}/.backstage-sessions`;
const CLAUDE_PROJECTS_DIR = `${HOME}/.claude/projects`;

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
]);

function resolveSlackUser(userId: string): string {
  // Could be a Slack user ID (e.g. UT41L6GCC) or already a display name
  const mapped = slackIdToFirstName(userId);
  if (mapped) return mapped;
  // Extract first name from "Firstname Lastname" format
  if (userId.includes(" ")) return userId.split(" ")[0];
  return userId;
}

export function getTranscriptPath(
  worktreeDir: string,
  sessionId: string
): string {
  const hash = worktreeDir.replaceAll("/", "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/-${hash}/${sessionId}.jsonl`;
}

function findTranscriptPath(
  worktreeDir: string | null,
  sessionId: string | null
): string | null {
  if (!sessionId) return null;
  if (worktreeDir) {
    const path = getTranscriptPath(worktreeDir, sessionId);
    if (existsSync(path)) return path;
  }
  // Fallback: check common CWD paths the agents use
  const fallbacks = [
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu-projects-tella-fusion/${sessionId}.jsonl`,
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu/${sessionId}.jsonl`,
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  return null;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function getFileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function scanSlackSessions(): UnifiedSession[] {
  if (!existsSync(SLACK_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<SlackSessionFile>(
      `${SLACK_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const branch = data.branch || file.replace(".json", "");
    const startedBy = data.userId
      ? resolveSlackUser(data.userId)
      : null;

    // Use a stable ID based on filename
    const id = `slack-${file.replace(".json", "")}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId || null,
      source: "slack",
      branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title: branch,
      lastActivity:
        data.lastActivity ||
        data.createdAt ||
        getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      createdAt:
        data.createdAt || getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: findTranscriptPath(
        data.worktreeDir || null,
        data.claudeSessionId || null
      ),
      slackThread: data.channel
        ? { channel: data.channel, threadTs: data.threadTs || "" }
        : undefined,
    });
  }
  return sessions;
}

function scanLinearSessions(): UnifiedSession[] {
  if (!existsSync(LINEAR_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(LINEAR_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<LinearSessionFile>(
      `${LINEAR_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const rawName =
      data.participants?.[0]?.name ||
      data.lastActiveUser?.name ||
      null;
    // Clean up email-style names (e.g. "john@tella.com" → "John")
    const startedBy = rawName?.includes("@")
      ? rawName.split("@")[0].charAt(0).toUpperCase() + rawName.split("@")[0].slice(1)
      : rawName;

    const title = data.issueIdentifier
      ? `${data.issueIdentifier}: ${data.issueTitle || data.branch}`
      : data.branch;

    const id = `linear-${data.branch}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId,
      source: "linear",
      branch: data.branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title,
      lastActivity:
        data.updatedAt || getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      createdAt: getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: findTranscriptPath(
        data.worktreeDir || null,
        data.claudeSessionId
      ),
      linearIssue: data.issueIdentifier
        ? {
            identifier: data.issueIdentifier,
            title: data.issueTitle || data.branch,
            url: data.issueUrl,
          }
        : undefined,
    });
  }
  return sessions;
}

function scanBackstageSessions(): UnifiedSession[] {
  if (!existsSync(BACKSTAGE_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(BACKSTAGE_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<BackstageSessionFile>(
      `${BACKSTAGE_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    sessions.push({
      id: data.id,
      claudeSessionId: data.claudeSessionId,
      source: "backstage",
      branch: data.branch || null,
      worktreeDir: data.worktreeDir || null,
      startedBy: data.createdBy,
      title: data.title || data.branch || "Ask session",
      mode: data.mode,
      automation:
        data.automation ||
        (data.createdBy?.endsWith(" (automation)")
          ? data.createdBy.slice(0, -" (automation)".length)
          : undefined),
      lastActivity: data.lastActivity,
      createdAt: data.createdAt,
      isRunning: false,
      transcriptPath: findTranscriptPath(
        data.worktreeDir,
        data.claudeSessionId
      ),
    });
  }
  return sessions;
}

function getRunningPids(): Map<string, number> {
  // Map of sessionId → pid for currently running CLI sessions
  const running = new Map<string, number>();
  if (!existsSync(CLI_SESSIONS_DIR)) return running;

  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<CLISessionFile>(`${CLI_SESSIONS_DIR}/${file}`);
    if (!data) continue;

    try {
      process.kill(data.pid, 0); // Check if PID is alive
      running.set(data.sessionId, data.pid);
    } catch {
      // PID is dead
    }
  }
  return running;
}

// PR cache: branch → { url, state }, refreshed every 60s
interface PrInfo { url: string; state: "OPEN" | "MERGED" | "CLOSED"; }
let prCache: { data: Map<string, PrInfo>; ts: number } = { data: new Map(), ts: 0 };
const PR_CACHE_TTL = 60_000;
let prRefreshing = false;

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// this repo, which used to freeze every agent in the process).
function getPrsByBranch(): Map<string, PrInfo> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

async function refreshPrCache(): Promise<void> {
  if (prRefreshing) return;
  prRefreshing = true;
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "list", "--repo", "tellahq/tella-fusion", "--state", "all",
       "--limit", "200", "--json", "headRefName,url,state"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const raw = await new Response(proc.stdout).text();
    const prs = JSON.parse(raw) as Array<{ headRefName: string; url: string; state: string }>;
    const map = new Map<string, PrInfo>();
    for (const pr of prs) {
      map.set(pr.headRefName, { url: pr.url, state: pr.state as PrInfo["state"] });
    }
    prCache = { data: map, ts: Date.now() };
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  } finally {
    prRefreshing = false;
  }
}

export function getAllSessions(): UnifiedSession[] {
  const slackSessions = scanSlackSessions();
  const linearSessions = scanLinearSessions();
  const backstageSessions = scanBackstageSessions();
  const runningPids = getRunningPids();

  // Merge all sessions, deduplicating by claudeSessionId
  const byClaudeId = new Map<string, UnifiedSession>();
  const allSessions: UnifiedSession[] = [];

  for (const session of [
    ...backstageSessions,
    ...linearSessions,
    ...slackSessions,
  ]) {
    if (session.claudeSessionId) {
      const existing = byClaudeId.get(session.claudeSessionId);
      if (existing) {
        // Keep the one with richer data (linear > backstage > slack)
        // but mark running status from either
        if (runningPids.has(session.claudeSessionId)) {
          existing.isRunning = true;
        }
        continue;
      }
      byClaudeId.set(session.claudeSessionId, session);
    }

    // Mark running status
    if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
      session.isRunning = true;
    }

    allSessions.push(session);
  }

  // Enrich with PR URLs and state
  const prs = getPrsByBranch();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prs.get(session.branch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
      }
    }
  }

  // Sort by lastActivity descending
  allSessions.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  return allSessions;
}

export function deleteSession(session: UnifiedSession): void {
  // Delete the session JSON file based on source
  switch (session.source) {
    case "slack": {
      // ID format: slack-{filename}
      const filename = session.id.replace(/^slack-/, "") + ".json";
      const path = `${SLACK_SESSIONS_DIR}/${filename}`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "linear": {
      // ID format: linear-{branch}
      const branch = session.id.replace(/^linear-/, "");
      const path = `${LINEAR_SESSIONS_DIR}/${branch}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "backstage": {
      const path = `${BACKSTAGE_SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
}
