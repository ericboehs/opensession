/**
 * Announce-then-stop guard (pure parts). The instruction-layer fix
 * (28731464, "Finish your turns") still lets an occasional turn end cleanly
 * on a plan sentence with zero tool calls — seen again 2026-07-12 in
 * bks-019f533e ("Research is complete… Now let me read the exact code…"),
 * where the session then sat idle overnight until the user typed "continue".
 * run-session.ts uses this detector to send ONE bounded auto-continue when a
 * clean, tool-less turn ends on an announced next action.
 */

/** Sentinel user for the auto-continue turn (also keys the one-nudge guard). */
export const AUTO_CONTINUE_USER = "auto-continue";

export const AUTO_CONTINUE_PROMPT =
	"[auto-continue] Your previous turn ended by announcing a next step without " +
	"executing it. Continue now: perform the step you announced, and keep working " +
	"until the task is done or you are genuinely blocked on input only the human " +
	"can give.";

/**
 * Does the reply's final sentence read as a next action the model was about
 * to take ("Now let me read the exact code…", "I'll rebase and then open the
 * PR") rather than a completion, question, or handoff to the human?
 * Deliberately narrow — a false positive costs a wasted turn, so anything
 * question-shaped or waiting-on-the-human returns false.
 */
export function announcesNextAction(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const tail = trimmed.slice(-400);
	const sentences = tail.split(/(?<=[.!?])\s+/);
	const last = (sentences[sentences.length - 1] || "").trim();
	if (!last || last.length < 12) return false;
	if (last.includes("?")) return false;
	// Waiting on the human is a legitimate stop, not an announce-then-stop.
	if (
		/\b(let me know|blocked on|waiting for|awaiting|your call|if you (?:want|prefer|disagree)|say the word|shall i|should i|want me to|i['’]ll (?:wait|hold|leave|stop))\b/i.test(
			last,
		)
	)
		return false;
	return /\b(let me|i['’]ll|i will|i['’]m going to|i['’]m about to|next,? i|now i['’]m|now i will)\b/i.test(
		last,
	);
}
