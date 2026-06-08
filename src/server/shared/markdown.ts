/**
 * Convert standard markdown to Slack mrkdwn format.
 * Ported from slack-agent — used by the Slack agent module.
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Headers: ## Header → *Header*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold URLs: **url** → <url> (Slack renders <url> as a proper link; bold-wrapped bare URLs don't auto-link)
  result = result.replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "<$1>");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Images: ![alt](url) → <url|alt>
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return result;
}
