/**
 * The first useful line of an intermediate thought. Reasoning often contains
 * markdown headings, bullets, and inline code; the row is a plain-text glance,
 * while the expanded body keeps the original markdown intact.
 */
export function thoughtSummary(content: string): string {
  return content
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
