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

/**
 * Strip the "[Name] " attribution prefix deliverToSession prepends, so the
 * agent-notice parsers below work on both the delivered form and a bare body
 * (tests, and the already-stripped `attribution.body` in MessageBubble). Wider
 * than ATTRIBUTION_RE's 40-char name cap on purpose: a worker is attributed as
 * "worker <session-id>", which is 47 chars and so never parses as an
 * attribution — the very reason these turns used to render as raw
 * "[worker bks-…] …" text in the human's own bubble.
 */
const ATTR_PREFIX_RE = /^\[[^\]\n]{1,80}\]\s*/;

/**
 * Detect a worker's report to its parent (workerReportPayload in
 * src/agents/slack/sessions-tools.ts): a child session's findings, delivered as
 * a user turn but authored by an agent — not an instruction from the human.
 *
 * Matched on the "worker <session-id>" attribution (which every such report has
 * carried since the feature shipped, so old transcripts render as cards too)
 * and/or the sentinel, kept in sync with WORKER_REPORT_SENTINEL in
 * sessions-tools.ts. Returns the worker's session id, for a link back to it.
 */
const WORKER_ATTR_RE = /^\[worker\s+([^\]\s]+)\]\s*/;
const WORKER_SENTINEL_RE = /^<!--os:worker-report(?::([^\s>]+))?-->\s*/;

/**
 * Notices stack: a worker whose whole job was a workflow reports back with the
 * workflow nudge as its body, so the turn carries both sentinels and the
 * matching parser only consumes its own. The markdown renderer escapes HTML,
 * so anything left over renders as a literal `<!--os:…-->` line at the top of
 * the card — plumbing the reader never has a use for.
 */
const LEADING_SENTINEL_RE = /^\s*<!--os:[a-z-]+(?::[^\s>]+)?-->\s*/;

function stripLeadingSentinels(text: string): string {
  let out = text;
  while (LEADING_SENTINEL_RE.test(out)) out = out.replace(LEADING_SENTINEL_RE, "");
  return out;
}

export function parseWorkerReport(
  content?: string,
): { sessionId: string | null; body: string } | null {
  if (!content) return null;
  let text = content;
  let sessionId: string | null = null;
  const attr = text.match(WORKER_ATTR_RE);
  if (attr) {
    sessionId = attr[1];
    text = text.slice(attr[0].length);
  }
  const sentinel = text.match(WORKER_SENTINEL_RE);
  if (sentinel) {
    sessionId = sentinel[1] || sessionId;
    text = text.slice(sentinel[0].length);
  }
  if (!attr && !sentinel) return null;
  return { sessionId, body: stripLeadingSentinels(text).trim() };
}

/**
 * Detect the "your workflow finished, pick the results up" nudge
 * (wakeOwningSession in src/server/workflow-runner.ts). It's delivered
 * attributed to the human who launched the run, so without this it renders as
 * a message the human appears to have typed. Sentinel kept in sync with
 * WORKFLOW_NOTICE_SENTINEL there; the status-emoji opener is the fallback for
 * notices delivered before the sentinel shipped.
 */
const WORKFLOW_SENTINEL_RE = /^<!--os:workflow-notice(?::([^\s>]+))?-->\s*/;
const LEGACY_WORKFLOW_RE = /^(?:✅|⚠️|⏹️)\s*Workflow\s+["“]/;

export function parseWorkflowNotice(
	content?: string,
): { runId: string | null; body: string } | null {
	if (!content) return null;
	const text = content.replace(ATTR_PREFIX_RE, "");
	const sentinel = text.match(WORKFLOW_SENTINEL_RE);
	const body = (sentinel ? text.slice(sentinel[0].length) : text).trim();
	if (!sentinel && !LEGACY_WORKFLOW_RE.test(body)) return null;
	// The notice must be the WHOLE message. A human typing while it lands gets
	// their words merged into the same turn ("<notice>\n\n<their question>") —
	// dimming those into the system pill would hide what they actually asked, so
	// a merged turn stays an ordinary user bubble.
	if (/\n\s*\n/.test(body)) return null;
	const run = sentinel?.[1] || body.match(/\b(wf-[\w-]+)/)?.[1] || null;
	return { runId: run, body };
}

/**
 * Detect the synthetic continuation prompt emitted after a service restart.
 * It is persisted as a user turn because the engine must act on it, but in the
 * transcript it is operational metadata rather than something the human typed.
 * Match the stable sentence instead of the persona name so renamed personas and
 * older transcripts get the same treatment.
 */
const RECOVERY_NOTICE_RE =
	/^This session was interrupted by an? [^\n]{1,80} service restart mid-run\.\s/;

export function parseRecoveryNotice(content?: string): { body: string } | null {
	if (!content || !RECOVERY_NOTICE_RE.test(content)) return null;
	return { body: content };
}

/**
 * Detect an informational heads-up sent by one session into another. The
 * server marks new notices; the strict opener keeps already-delivered notices
 * from before the marker shipped from looking like words the human typed.
 */
const SESSION_NOTICE_SENTINEL_RE = /^<!--os:session-notice-->\s*/;
const LEGACY_SESSION_NOTICE_RE = /^Heads-up from another session(?:\s*\([^\n)]*\))?:/i;

export function parseSessionNotice(content?: string): { body: string } | null {
	if (!content) return null;
	const text = content.replace(ATTR_PREFIX_RE, "");
	const sentinel = text.match(SESSION_NOTICE_SENTINEL_RE);
	const body = (sentinel ? text.slice(sentinel[0].length) : text).trim();
	if (!sentinel && !LEGACY_SESSION_NOTICE_RE.test(body)) return null;
	// Co-released steers can be joined into one user entry. Keep that entry as a
	// user turn rather than folding a real attributed instruction into the notice.
	if (/\n\s*\n\[[^\]\n]{1,80}\]\s+/.test(body)) return null;
	return { body };
}
