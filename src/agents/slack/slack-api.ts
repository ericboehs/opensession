/**
 * Slack API helpers for the Slack agent.
 *
 * Wraps common Slack Web API calls (chat.postMessage, reactions, etc.)
 * using fetch() + SLACK_BOT_TOKEN from process.env.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

/**
 * Slack's API should respond in a couple seconds; if we don't hear back in 30s
 * something is wrong (network, Slack side, auth). Without this, a wedged fetch
 * can stall the entire message queue indefinitely.
 */
const SLACK_FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = SLACK_FETCH_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Status messages
// ---------------------------------------------------------------------------

export const MESSAGES = {
  received: "Got it, let me think about this...",
  thinking: "I'm analyzing the situation...",
  worktreeCreating: "Setting up a worktree for this task...",
  worktreeReady: "Worktree ready! Running Claude Code...",
  complete: "Done!",
  error: "Oops, something went wrong.",
};

// ---------------------------------------------------------------------------
// Core API call helper
// ---------------------------------------------------------------------------

export async function slackApiCall(
  method: string,
  params: Record<string, any>
): Promise<any> {
  const resp = await fetchWithTimeout(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!(data as any).ok) {
    console.warn(`[slack] Slack API ${method} error:`, (data as any).error);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export async function sendSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
      mrkdwn: true,
    }),
  });
  return response.json();
}

export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, ts, text, mrkdwn: true }),
  });
  return response.json();
}

export async function addReaction(
  channel: string,
  ts: string,
  emoji: string
): Promise<void> {
  await fetchWithTimeout("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
  });
}

export async function removeReaction(
  channel: string,
  ts: string,
  emoji: string
): Promise<void> {
  await fetchWithTimeout("https://slack.com/api/reactions.remove", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
  });
}

export async function postSlackBlocks(
  channel: string,
  fallbackText: string,
  blocks: any[],
  threadTs?: string
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel,
      text: fallbackText,
      blocks,
      thread_ts: threadTs,
    }),
  });
  return response.json();
}

export async function updateSlackBlocks(
  channel: string,
  ts: string,
  text: string,
  blocks: any[]
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, ts, text, blocks }),
  });
  return response.json();
}

export async function openSlackModal(
  triggerId: string,
  questionId: string,
  questionText: string
): Promise<any> {
  const response = await fetchWithTimeout("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: `askq-modal-${questionId}`,
        title: { type: "plain_text", text: "Custom Answer", emoji: true },
        submit: { type: "plain_text", text: "Submit", emoji: true },
        close: { type: "plain_text", text: "Cancel", emoji: true },
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: questionText },
          },
          {
            type: "input",
            block_id: "answer_block",
            element: {
              type: "plain_text_input",
              action_id: "answer_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "Type your answer...",
              },
            },
            label: { type: "plain_text", text: "Your answer", emoji: true },
          },
        ],
      },
    }),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Context fetchers
// ---------------------------------------------------------------------------

export async function fetchThreadContext(
  channel: string,
  threadTs: string
): Promise<string> {
  const response = await fetchWithTimeout(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=20`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
  const data = (await response.json()) as any;

  if (!data.ok || !data.messages) {
    console.error("[slack] Failed to fetch thread:", data.error);
    return "";
  }

  return data.messages
    .map((msg: any) => `[${msg.user || "bot"}]: ${msg.text}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Channel info / kind (for memory scoping)
// ---------------------------------------------------------------------------

export async function getChannelInfo(
  channelId: string
): Promise<{ is_private?: boolean; is_im?: boolean } | null> {
  const data = await slackApiCall("conversations.info", { channel: channelId });
  if (data.ok && data.channel) return data.channel;
  return null;
}

const channelKindCache = new Map<
  string,
  { isDM: boolean; isPrivate: boolean; at: number }
>();
const CHANNEL_KIND_TTL_MS = 60 * 60 * 1000;

/**
 * Resolve whether a channel is a DM / private channel. Cached for an hour —
 * modern Slack uses "C…" ids for both public and private channels, so we can't
 * tell them apart from the id alone and must ask conversations.info.
 */
export async function getChannelKind(
  channelId: string
): Promise<{ isDM: boolean; isPrivate: boolean }> {
  if (channelId.startsWith("D")) return { isDM: true, isPrivate: false };
  const cached = channelKindCache.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_KIND_TTL_MS) {
    return { isDM: cached.isDM, isPrivate: cached.isPrivate };
  }
  const info = await getChannelInfo(channelId);
  const kind = { isDM: !!info?.is_im, isPrivate: !!info?.is_private };
  channelKindCache.set(channelId, { ...kind, at: Date.now() });
  return kind;
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

export async function getUserInfo(
  userId: string
): Promise<{ name: string; real_name: string } | null> {
  const response = await fetchWithTimeout(
    `https://slack.com/api/users.info?user=${userId}`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
  const data = (await response.json()) as any;
  if (data.ok && data.user) {
    return {
      name: data.user.name,
      real_name: data.user.real_name || data.user.name,
    };
  }
  return null;
}
