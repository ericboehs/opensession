/**
 * Injected prompt context vs. what the human typed.
 *
 * The model needs a lot of injected context on a turn — the system preamble
 * (especially for Codex, which has no separate system channel so it all rides
 * on the user turn), the repos note, and the engine-switch handoff transcript.
 * All of that is plumbing: it belongs in the model's input but NOT in the
 * rendered conversation, where it reads as a giant unexplained "You" message.
 *
 * We fence injected blocks with these sentinels. The runners keep them in the
 * prompt sent to the model; the transcript parser strips fenced blocks so the
 * UI shows only the human's actual message (the model-switch divider already
 * conveys that the engine changed). Sentinels are inert tag-like text the model
 * simply reads as context.
 */
export const CTX_OPEN = "<backstage:context>";
export const CTX_CLOSE = "</backstage:context>";

/** Fence a block of injected context so it renders invisibly in the transcript. */
export function wrapContext(body: string): string {
  // Neutralize any fence sentinels inside the body: a nested
  // <backstage:context> marker in inlined content (e.g. a side chat's
  // transcript that literally contains the string) would otherwise let that
  // content break out of the fence and inject unfenced instructions into the
  // agent — a prompt-injection vector. A sentinel inside a fenced block is
  // never legitimate, so replacing the angle brackets is always safe.
  const safe = body
    .replaceAll(CTX_OPEN, "‹backstage:context›")
    .replaceAll(CTX_CLOSE, "‹/backstage:context›");
  return `${CTX_OPEN}\n${safe}\n${CTX_CLOSE}`;
}

const STRIP_RE = new RegExp(`${CTX_OPEN}[\\s\\S]*?${CTX_CLOSE}\\n*`, "g");

/** Remove fenced context blocks (and any trailing blank lines) for display. */
export function stripContext(text: string): string {
  if (!text || !text.includes(CTX_OPEN)) return text;
  return text.replace(STRIP_RE, "").trimStart();
}
