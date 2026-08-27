export type SafetyQueuedPrompt = {
  content: string;
  user?: string;
  images?: string[];
  files?: unknown;
};

/** Opening prompt for the safe successor. Transcript context is carried by the
 * fork handoff; this block preserves messages that never reached that history. */
export function safetyContinuationPrompt(
  sourceTitle: string,
  queued: readonly SafetyQueuedPrompt[],
): string {
  const header =
    `Continue the work from the paused session “${sourceTitle}”. ` +
    "Review the carried conversation before acting, avoid repeating uncertain side effects, and finish the task safely.";
  if (!queued.length) return header;
  const messages = queued.slice(0, 20).map((item, index) => {
    const author = item.user?.trim() || "User";
    const content = item.content.trim() || "(attachment only)";
    const attachments =
      (item.images?.length || 0) +
      (Array.isArray(item.files) ? item.files.length : 0);
    return `${index + 1}. ${author}: ${content}${attachments ? ` (${attachments} attachment${attachments === 1 ? "" : "s"})` : ""}`;
  });
  return `${header}\n\nThe following queued messages were waiting and must be handled in order:\n${messages.join("\n")}`;
}
