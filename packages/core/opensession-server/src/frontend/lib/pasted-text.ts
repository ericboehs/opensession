export const PASTED_TEXT_THRESHOLD = 2_500;

export interface PastedTextAttachment {
  id: string;
  text: string;
}

export function shouldCollapsePastedText(text: string): boolean {
  return text.length >= PASTED_TEXT_THRESHOLD;
}

export function createPastedTextAttachment(text: string): PastedTextAttachment {
  return { id: crypto.randomUUID(), text };
}

export function pastedTextLineLabel(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).length;
  return `+${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** Attachments lead the visible instruction, matching other prompt context. */
export function composePastedText(
  text: string,
  attachments: PastedTextAttachment[],
): string {
  if (attachments.length === 0) return text;
  return [...attachments.map((attachment) => attachment.text), text]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
