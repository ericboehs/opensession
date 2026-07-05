// Live code styling for the composer. The draft stays a plain <textarea>
// (native caret, selection, undo, IME); a metrics-identical mirror div behind
// it paints this HTML. Because the mirror must line up glyph-for-glyph with
// the textarea, styling is COLOR/BACKGROUND ONLY — the markup here never adds
// padding, font, or size changes.

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Wrap `inline code` spans within a non-fence segment. */
function inlineCode(seg: string): string {
	let out = "";
	let last = 0;
	const re = /`[^`\n]+`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(seg))) {
		out += esc(seg.slice(last, m.index));
		out += `<span class="cmp-code">${esc(m[0])}</span>`;
		last = m.index + m[0].length;
	}
	return out + esc(seg.slice(last));
}

/**
 * Render a composer draft to mirror HTML: ``` fences (closed, or open-ended
 * while still being typed) become .cmp-fence, `inline code` becomes .cmp-code.
 * Inline backticks inside a fence are left alone. A trailing zero-width space
 * keeps the mirror's last line from collapsing when the draft ends in \n.
 */
export function composerHighlightHtml(text: string): string {
	let out = "";
	let last = 0;
	const re = /```[\s\S]*?```|```[\s\S]*$/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out += inlineCode(text.slice(last, m.index));
		out += `<span class="cmp-fence">${esc(m[0])}</span>`;
		last = m.index + m[0].length;
	}
	out += inlineCode(text.slice(last));
	return out + "​";
}

/** Only mount the mirror when the draft can actually contain code markup —
 * plain drafts keep the stock opaque textarea (zero desync risk). */
export function needsComposerHighlight(text: string): boolean {
	return text.includes("`");
}
