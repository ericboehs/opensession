/**
 * Slack link unfurling for OpenSession session links.
 *
 * When someone pastes an `os.tella.dev/session/<id>` link into Slack, Slack
 * fires a `link_shared` event (the app must have `links:read`/`links:write` and
 * register the domain as an unfurl domain). We can't rely on Open Graph tags
 * because os.tella.dev is tailnet-only — Slack's crawler can't reach it — so
 * instead we look the session up in-process and post a rich preview back with
 * `chat.unfurl`.
 */

import { slackApiCall } from "./slack-api";
import { findSession } from "../../server/session-cache";
import type { UnifiedSession } from "../../server/types";

const UI_BASE =
  process.env.OPENSESSION_UI_BASE ||
  process.env.MICHAEL_UI_BASE ||
  "https://os.tella.dev";

function uiHost(): string {
  try {
    return new URL(UI_BASE).host;
  } catch {
    return "os.tella.dev";
  }
}

/**
 * Extract a session id from an OpenSession URL, or null if it isn't one of ours.
 * Handles the legacy `/opensession/…` and `/backstage/…` path prefixes that
 * 301 to the bare form (Slack sends whatever the user pasted), and both URL
 * shapes the UI produces:
 *   - `/session/<id>`
 *   - `/workspace/<projectId>/chat/<id>`  (the deep-link the app copies today)
 */
export function sessionIdFromUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.host !== uiHost()) return null;
  let path = u.pathname;
  if (path === "/opensession" || path.startsWith("/opensession/")) {
    path = path.slice("/opensession".length);
  } else if (path === "/backstage" || path.startsWith("/backstage/")) {
    path = path.slice("/backstage".length);
  }
  const m =
    path.match(/^\/session\/([^/?#]+)/) ||
    path.match(/^\/workspace\/[^/?#]+\/chat\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Escape text going into Slack mrkdwn (esp. inside a `<url|text>` link). */
function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Drop the provider/family prefix from a model id: opencode/anthropic/foo → foo. */
function modelLabel(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

function statusChip(s: UnifiedSession): string {
  if (s.isRunning) return "🟢 In progress";
  if (s.lastRunError) return "🔴 Needs input";
  if (s.prState === "MERGED") return "🟣 Merged";
  if (s.prState === "CLOSED") return "⚪ Closed";
  if (s.prState === "OPEN" || s.prUrl) return "🔵 In review";
  return "⚪ Idle";
}

/** Build the Block Kit unfurl body for one session. */
function unfurlForSession(s: UnifiedSession, url: string): { blocks: any[] } {
  const title = (s.title || s.id).trim();

  const bits: string[] = [statusChip(s)];
  if (s.repo) bits.push(s.branch ? `${s.repo} · \`${s.branch}\`` : s.repo);
  if (s.model) bits.push(modelLabel(s.model));
  if (s.mode) bits.push(s.mode);
  if (s.startedBy) bits.push(`by ${s.startedBy}`);

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${url}|${esc(title)}>*` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: bits.join("  ·  ") }],
    },
  ];

  if (s.prUrl) {
    const num = s.prNumber ? `#${s.prNumber}` : "PR";
    const prTitle = s.prTitle ? ` ${esc(s.prTitle)}` : "";
    const c = s.prChecks;
    const checks =
      c && c.total
        ? `  ·  checks ${c.passed}/${c.total}${c.failed ? ` (${c.failed} failed)` : ""}`
        : "";
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `<${s.prUrl}|${num}${prTitle}>${checks}` },
      ],
    });
  }

  return { blocks };
}

/**
 * Handle a Slack `link_shared` event: look up every OpenSession session link in
 * the message and post rich previews back via chat.unfurl. Unknown or foreign
 * links are ignored; if none resolve we make no API call.
 */
export async function handleLinkShared(event: any): Promise<void> {
  const links: Array<{ url: string; domain?: string }> = event.links || [];
  const unfurls: Record<string, { blocks: any[] }> = {};

  for (const link of links) {
    const id = sessionIdFromUrl(link.url);
    if (!id) continue;
    const session = findSession(id);
    if (!session) continue;
    unfurls[link.url] = unfurlForSession(session, link.url);
  }

  if (Object.keys(unfurls).length === 0) return;

  await slackApiCall("chat.unfurl", {
    channel: event.channel,
    ts: event.message_ts,
    unfurls,
  });
}
