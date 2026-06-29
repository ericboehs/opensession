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
