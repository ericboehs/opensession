/**
 * Worktree channel management for the Slack agent.
 *
 * Maps Slack channels to git worktree branches.
 * Handles channel creation/archival, topic setting, and stale worktree cleanup.
 */

import { sendSlackMessage } from "./slack-api";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import {
  githubApi,
  findGitHubUsersForBranch,
  inviteRelevantUsersToChannel,
} from "./github-reviews";
import {
  SESSION_DIR,
  DEFAULT_CWD,
  GITHUB_REPO,
  activeSessions,
} from "./state";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const WORKTREE_CHANNELS_FILE = `${SESSION_DIR}/worktree-channels.json`;

// ---------------------------------------------------------------------------
// State: channel <-> branch mappings
// ---------------------------------------------------------------------------

export const worktreeChannels = new Map<string, string>(); // channelId -> branch
export const branchToChannel = new Map<string, string>(); // branch -> channelId

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveWorktreeChannels(): Promise<void> {
  const data: Record<string, string> = {};
  for (const [channelId, branch] of worktreeChannels) {
    data[channelId] = branch;
  }
  writeJsonAtomic(WORKTREE_CHANNELS_FILE, data);
}

export async function loadWorktreeChannels(): Promise<void> {
  try {
    const file = Bun.file(WORKTREE_CHANNELS_FILE);
    if (await file.exists()) {
      const data = JSON.parse(await file.text()) as Record<string, string>;
      for (const [channelId, branch] of Object.entries(data)) {
        worktreeChannels.set(channelId, branch);
        branchToChannel.set(branch, channelId);
      }
      console.log(
        `[slack] Loaded ${worktreeChannels.size} worktree channel mapping(s)`
      );
    }
  } catch (e) {
    console.warn("[slack] Failed to load worktree channels:", e);
  }
}

// ---------------------------------------------------------------------------
// Channel name helpers
// ---------------------------------------------------------------------------

export function branchToChannelName(branch: string): string {
  return (
    "worktree-" +
    branch
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 71) // 80 max - "worktree-" prefix = 71
  );
}

export function isWorktreeChannel(channelId: string): boolean {
  return worktreeChannels.has(channelId);
}

export function getWorktreeDirForChannel(channelId: string): string | null {
  const branch = worktreeChannels.get(channelId);
  if (!branch) return null;
  return `/home/ubuntu/worktrees/tella-fusion-${branch}`;
}

// ---------------------------------------------------------------------------
// Find an existing Slack channel by name
// ---------------------------------------------------------------------------

export async function findSlackChannel(name: string): Promise<string | null> {
  let cursor = "";
  do {
    const params = new URLSearchParams({
      types: "public_channel",
      limit: "200",
      exclude_archived: "false",
    });
    if (cursor) params.set("cursor", cursor);

    const response = await fetchWithTimeout(
      `https://slack.com/api/conversations.list?${params}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const data = (await response.json()) as any;

    if (!data.ok) {
      console.error("[slack] conversations.list error:", data.error);
      return null;
    }

    for (const ch of data.channels || []) {
      if (ch.name === name) return ch.id;
    }

    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);

  return null;
}

// ---------------------------------------------------------------------------
// Create a Slack channel
// ---------------------------------------------------------------------------

export async function createSlackChannel(
  name: string
): Promise<{ ok: boolean; channelId?: string; error?: string }> {
  const response = await fetchWithTimeout("https://slack.com/api/conversations.create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ name, is_private: false }),
  });
  const data = (await response.json()) as any;

  if (data.ok) {
    return { ok: true, channelId: data.channel.id };
  }

  // If name is taken, find the existing channel
  if (data.error === "name_taken") {
    const existing = await findSlackChannel(name);
    if (existing) {
      // Check if it's archived — if so, we can't reuse it (bot can't unarchive)
      // Create with a numeric suffix instead
      const infoResp = await fetchWithTimeout(
        `https://slack.com/api/conversations.info?channel=${existing}`,
        { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
      );
      const info = (await infoResp.json()) as any;
      if (info.ok && info.channel?.is_archived) {
        console.log(
          `[slack] Channel #${name} is archived, creating with suffix`
        );
        const suffixed = name.slice(0, 76) + `-${Date.now() % 10000}`;
        return createSlackChannel(suffixed);
      }
      return { ok: true, channelId: existing };
    }
  }

  return { ok: false, error: data.error };
}

// ---------------------------------------------------------------------------
// Archive a Slack channel
// ---------------------------------------------------------------------------

export async function archiveSlackChannel(
  channelId: string
): Promise<boolean> {
  const response = await fetchWithTimeout(
    "https://slack.com/api/conversations.archive",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId }),
    }
  );
  const data = (await response.json()) as any;
  if (!data.ok && data.error !== "already_archived") {
    console.error("[slack] conversations.archive error:", data.error);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Set channel topic
// ---------------------------------------------------------------------------

export async function setChannelTopic(
  channelId: string,
  topic: string
): Promise<void> {
  await fetchWithTimeout("https://slack.com/api/conversations.setTopic", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: channelId, topic }),
  });
}

// ---------------------------------------------------------------------------
// Invite bot to a channel
// ---------------------------------------------------------------------------

export async function inviteBotToChannel(channelId: string): Promise<void> {
  const joinResp = await fetchWithTimeout("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: channelId }),
  });
  const joinData = (await joinResp.json()) as any;
  if (!joinData.ok) {
    console.error("[slack] conversations.join error:", joinData.error);
  }
}

// ---------------------------------------------------------------------------
// Auto-cleanup stale worktrees (cron)
// ---------------------------------------------------------------------------

export async function cleanupWorktrees(): Promise<void> {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const { spawnSync } = require("child_process");

  try {
    // List all worktree branches
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: DEFAULT_CWD,
      encoding: "utf-8",
    });
    if (result.status !== 0) return;

    const worktreePaths = (result.stdout as string)
      .split("\n")
      .filter((l: string) => l.startsWith("worktree "))
      .map((l: string) => l.replace("worktree ", ""))
      .filter((p: string) => p !== DEFAULT_CWD); // skip main repo

    for (const wtPath of worktreePaths) {
      const branch = wtPath.split("/").pop()?.replace("tella-fusion-", "");
      if (!branch) continue;

      // Check if PR for this branch is merged
      const prs = await githubApi(
        `/repos/${GITHUB_REPO}/pulls?head=tellahq:${branch}&state=closed&per_page=1`
      );
      const hasMergedPR =
        prs && Array.isArray(prs) && prs.length > 0 && prs[0].merged_at;

      if (hasMergedPR) {
        console.log(
          `[slack] [cleanup] Branch ${branch} has merged PR #${prs[0].number}, cleaning up`
        );
      } else {
        // No merged PR — only clean up if older than 7 days
        const sessionEntry = [...activeSessions.entries()].find(
          ([, s]) => s.branch === branch
        );
        const session = sessionEntry?.[1];
        let lastActiveMs = session?.lastActivity
          ? new Date(session.lastActivity).getTime()
          : 0;

        // Fallback: check worktree directory mtime
        if (!lastActiveMs) {
          try {
            const stat = spawnSync("stat", ["-c", "%Y", wtPath], {
              encoding: "utf-8",
            });
            lastActiveMs = parseInt(stat.stdout?.trim() || "0") * 1000;
          } catch {}
        }

        if (!lastActiveMs || Date.now() - lastActiveMs < SEVEN_DAYS) continue;
        console.log(
          `[slack] [cleanup] Branch ${branch} has no PR and is older than 7 days, cleaning up`
        );
      }

      // Clean up via wt delete (sessions can be revived — worktree gets recreated)
      const del = spawnSync("/home/ubuntu/bin/wt", ["delete", branch], {
        encoding: "utf-8",
        timeout: 30000,
      });
      if (del.status === 0) {
        console.log(`[slack] [cleanup] Deleted worktree: ${branch}`);
      } else {
        console.warn(
          `[slack] [cleanup] Failed to delete ${branch}: ${del.stderr}`
        );
      }
    }
  } catch (e) {
    console.error("[slack] [cleanup] Worktree cleanup error:", e);
  }
}
