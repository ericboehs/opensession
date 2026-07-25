/**
 * Detect a teammate's answer that the human-in-the-loop feature
 * (src/server/human-asks.ts) routed back into a session. Such a message arrives
 * as a "user" turn (or a transient steer/queue receipt), but it's not the
 * session driver — so the UI credits the teammate in a distinct bubble.
 *
 * Tolerant of:
 *  - an optional "[Name] " steer-attribution prefix,
 *  - the current 💬 + **bold** format and the older :speech_balloon: + *italic*
 *    (or bare, when copied from rendered text) forms.
 */
const HEAD =
  "(?:\\[[^\\]]+\\]\\s*)?(?:💬|:speech_balloon:)\\s*\\*{0,2}\\s*(.+?)\\s*\\*{0,2}\\s+(?:answered|replied)\\b";
const HUMAN_REPLY_RE = new RegExp("^" + HEAD);
const HUMAN_REPLY_HEADER = new RegExp("^" + HEAD + "[^\\n]*\\n+");

export function parseHumanReply(content?: string): { name: string; body: string } | null {
  if (!content) return null;
  const m = content.match(HUMAN_REPLY_RE);
  if (!m) return null;
  const body = content.replace(HUMAN_REPLY_HEADER, "").trim();
  return { name: m[1].trim(), body };
}

/**
 * Detect the plain "[Name] " attribution prefix the server prepends when a
 * *named* teammate drives someone else's session — a steer, interrupt,
 * batch-queued prompt, or a cross-session `send_to_session` (backstage.ts).
 * Unlike a human-in-the-loop ask answer (parseHumanReply), this turn IS the
 * session driver, so it gets a normal bubble — but credited to whoever sent it,
 * not the viewer ("You"). Returns the sender + the prefix-stripped message.
 *
 * Kept deliberately strict (single-line, brace-free name ≤40 chars) so an
 * ordinary prompt that opens with "[WIP] …" isn't mistaken for an attribution.
 */
const ATTRIBUTION_RE = /^\[([^\]\n{}]{1,40})\]\s+([\s\S]*)$/;

export function parseAttribution(content?: string): { name: string; body: string } | null {
  if (!content) return null;
  const m = content.match(ATTRIBUTION_RE);
  if (!m) return null;
  return { name: m[1].trim(), body: m[2] };
}

export function isGitHubAttribution(name?: string | null): boolean {
  return name === "GitHub" || name === "GitHub (automation)";
}

/**
 * Detect a review-handoff delivery (src/agents/github/handoff.ts): an
 * unsatisfied PR review's findings pushed into the owning session. Arrives as a
 * GitHub-attributed user turn; the sentinel (kept in sync with
 * REVIEW_HANDOFF_SENTINEL in src/agents/github/prompts.ts) marks it, with the
 * pre-sentinel "🔍 This session's PR #…" opener as a fallback so handoffs
 * delivered before the sentinel shipped render as cards too. Returns the
 * PR number (for the card header) and the sentinel-stripped body.
 */
const REVIEW_HANDOFF_SENTINEL = "<!--os:review-handoff-->";
const LEGACY_HANDOFF_RE = /^🔍 This session'?s PR #\d+/;

export function parseReviewHandoff(body?: string): { prNumber: number | null; body: string } | null {
  if (!body) return null;
  let text = body;
  if (text.startsWith(REVIEW_HANDOFF_SENTINEL)) {
    text = text.slice(REVIEW_HANDOFF_SENTINEL.length).replace(/^\n+/, "");
  } else if (!LEGACY_HANDOFF_RE.test(text)) {
    return null;
  }
  const pr = text.match(/PR #(\d+)/);
  return { prNumber: pr ? parseInt(pr[1], 10) : null, body: text };
}
