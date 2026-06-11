/**
 * Tella's support voice bans em dashes in customer-facing text. The triage
 * and agent prompts say so explicitly, but models keep emitting them anyway —
 * so it's enforced mechanically here, on the tool inputs that write to Plain
 * (canUseTool rewrites the input before the MCP call executes).
 *
 * Note: Codex runs have no canUseTool hook, so this only covers Claude runs.
 */

export function stripEmDashes(text: string): string {
  return (
    text
      // Em-dash bullets at line start become hyphen bullets
      .replace(/^[ \t]*—[ \t]*/gm, "- ")
      // Inline em dashes read fine as a comma in support prose
      .replace(/[ \t]*—[ \t]*/g, ", ")
      // Tidy artifacts: ", ," and "., " style doubles
      .replace(/,[ \t]*,/g, ",")
      .replace(/([.!?:;]),[ \t]/g, "$1 ")
  );
}

const PLAIN_WRITE_TOOLS = new Set([
  "mcp__plain__create_note",
  "mcp__plain__reply_to_thread",
]);

/** Rewrite Plain note/reply tool inputs to match the support voice. */
export function cleanPlainToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!PLAIN_WRITE_TOOLS.has(toolName)) return input;
  const out: Record<string, unknown> = { ...input };
  for (const key of ["text", "markdown"]) {
    if (typeof out[key] === "string") out[key] = stripEmDashes(out[key] as string);
  }
  return out;
}
