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
 * Fenced context appended to a prompt that was delivered by ABORTING the
 * running turn (busy-send interrupt). The engine has no mid-turn steer (see
 * "why opencode stops": every busy-send is an abort, and the truncated turn
 * left in history primes a short acknowledge-then-stop reply — the main
 * announce-then-stop trigger). This note reframes the delivery as a steer so
 * the model folds it into the work in progress instead of parking. Remove
 * when the engine gains real mid-turn steering (opencode v2 delivery:"steer").
 */
export const INTERRUPT_STEER_NOTE =
	"Delivery note: the user sent this while your previous turn was still " +
	"executing; that turn was interrupted to deliver it. Treat it as a mid-task " +
	"steer — fold it into the work in progress and continue executing in THIS " +
	"turn: pick up any interrupted step that is still needed, act on the new " +
	"message, and keep working until done or genuinely blocked. Do not end the " +
	"turn on a bare acknowledgment or an announcement of what you will do.";

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
	if (
		/\b(let me|i['’]ll|i will|i['’]m going to|i['’]m about to|next,? i|now i['’]m|now i will)\b/i.test(
			last,
		)
	)
		return true;
	// Bare gerund announcements ("Fetching the review comments on #4791.",
	// "Now running the tests.") — seen 2026-07-12 in bks-019f54f8, where the
	// first-person patterns above missed and the session parked. The verb must
	// be followed by an object-ish token so completion shapes ("Testing
	// complete.", "Everything is working.") and -ing non-verbs ("During the
	// run…") stay out.
	const gerund = /^(?:(?:now|next|first|then|ok(?:ay)?),?\s+)?([a-z]+ing)\s+(\S.*)/i.exec(
		last,
	);
	if (!gerund) return false;
	if (NON_VERB_ING.has(gerund[1].toLowerCase())) return false;
	return (
		/^(?:the|a|an|this|that|these|those|it|its|my|our|your|all|both|each|some|more|on)\b/i.test(
			gerund[2],
		) || /^[A-Z0-9`"'@[#]/.test(gerund[2])
	);
}

/** -ing words that open sentences without being an action the model is taking. */
const NON_VERB_ING = new Set([
	"during",
	"nothing",
	"everything",
	"anything",
	"something",
	"warning",
	"pending",
	"assuming",
	"regarding",
	"according",
	"meaning",
	"interesting",
]);
