import { CAP_LABEL } from "./cap-label";
import type { SessionSource } from "./types";

/**
 * Source chips — the small pill naming where a session came from (slack,
 * linear, ask), plus the neutral variant the "Archived" button wears.
 *
 * The tone is a LOOKUP, not a built class name. The markup used to spell
 * `` `source-chip source-${session.source}` ``, which works for a stylesheet
 * but cannot work for utilities: Tailwind only compiles class names it can
 * find in the source, so a name assembled at runtime compiles to nothing at
 * all. Every tone below is a literal string for that reason — do not
 * reintroduce interpolation here.
 *
 * The tints themselves are tokens in base.css (`--chip-*`), so they re-tone
 * for the light theme on their own; see the note there.
 */
export const SOURCE_CHIP =
	"shrink-0 rounded-full px-2 py-0.5 text-meta font-bold tracking-[-0.01em]";

/** Neutral pill — the origins that get no hue of their own. */
const NEUTRAL = "bg-active text-dim";

const TONE: Record<string, string> = {
	slack: "bg-[var(--chip-slack-bg)] text-[var(--chip-slack-fg)]",
	linear: "bg-[var(--chip-linear-bg)] text-[var(--chip-linear-fg)]",
	ask: "bg-[var(--chip-ask-bg)] text-[var(--chip-ask-fg)]",
	cli: NEUTRAL,
};

/**
 * The tone for a session origin. `opensession` deliberately resolves to no
 * tone: the chip is only rendered for origins that are worth calling out, and
 * an untinted chip is what the app shipped. (The teal `.source-backstage`
 * rule this replaced had been unreachable since the rename — no session
 * carries that source any more.)
 */
export function sourceChipTone(source: SessionSource | "ask" | string): string {
	return TONE[source] ?? "";
}

/**
 * The "Archived" chip in the session header. Not a source chip: it is a state,
 * and a button, so it stands on its own class rather than overriding
 * SOURCE_CHIP. It carries the archive glyph beside the word — the word alone
 * read as a label dropped into the title line, where the glyph names the state
 * the way the automation and sandbox badges beside it name theirs.
 *
 * Medium, not bold: the glyph is a 1.5 stroke, and bold text next to it reads
 * as two weights in one chip.
 *
 * The two paddings are deliberately unequal, and the smaller one is on the
 * glyph's side: a 24-grid glyph draws only ~60% of its box, so it brings ~3px
 * of its own air, while a word ends on a stem with almost none. Equal numbers
 * there measure equal and look lopsided — the eye compares the air at the two
 * ENDS of the pill. Same rule the inline markdown chips follow in base.css.
 */
export const SOURCE_CHIP_ARCHIVED =
	"inline-flex shrink-0 cursor-pointer items-center gap-[3px] rounded-full bg-active py-[3px] pl-[7px] pr-[9px] " +
	"text-meta font-medium leading-[1.2] text-dim transition-[background,color] " +
	"duration-[var(--dur-micro)] ease-[var(--ease)] [&:hover:not(:disabled)]:bg-hover " +
	"[&:hover:not(:disabled)]:text-fg disabled:cursor-default disabled:opacity-60";

/** The chip's label, centred on its cap band like every other one. */
export const SOURCE_CHIP_ARCHIVED_LABEL = CAP_LABEL;
