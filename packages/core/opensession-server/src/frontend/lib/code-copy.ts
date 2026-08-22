/**
 * The controls on a rendered code fence: copy, plus a per-block wrap switch.
 *
 * Built as DOM rather than JSX for the same reason the mermaid expand button
 * is (MarkdownBody.tsx): a markdown body is injected as an innerHTML string,
 * so there is no element for React to own. The controls are siblings of the
 * <pre>, keeping them fixed while an unwrapped block scrolls sideways and
 * keeping their labels out of copied code.
 */

import { checkIconMarkup, copyIconMarkup } from "../components/icons";
import { copyToClipboard } from "./share-link";

const WRAP_CLASS = "md-code-wrap";
const CONTROLS_CLASS = "md-code-controls";
const COPY_BUTTON_CLASS = "md-code-copy";
const WRAP_BUTTON_CLASS = "md-code-wrap-toggle";
const COPY_LABEL = "Copy code";
const COPIED_LABEL = "Copied";
const WRAP_LABEL = "Wrap code";
/** How long the check stays before the copy glyph comes back. */
const COPIED_MS = 1600;

const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * The block's text as it is laid out. `innerText` rather than `textContent`:
 * shiki wraps every line in its own `<span class="line">` and does not
 * reliably leave a newline between them, so textContent can hand back a
 * forty-line block as one unbroken line. Layout is what knows where the
 * breaks are.
 */
function codeText(pre: HTMLElement): string {
	const text = pre.innerText || pre.textContent || "";
	// A fence always ends in a newline the author did not type.
	return text.replace(/\n+$/, "");
}

function flashCopied(button: HTMLElement): void {
	const running = flashTimers.get(button);
	if (running) clearTimeout(running);
	button.dataset.copied = "";
	button.title = COPIED_LABEL;
	button.setAttribute("aria-label", COPIED_LABEL);
	flashTimers.set(
		button,
		setTimeout(() => {
			delete button.dataset.copied;
			button.title = COPY_LABEL;
			button.setAttribute("aria-label", COPY_LABEL);
			flashTimers.delete(button);
		}, COPIED_MS),
	);
}

/**
 * Give every code fence under `root` its controls. Idempotent: a fence that
 * already sits in a wrapper is left alone, so this can run again after a
 * re-render without stacking controls.
 */
export function decorateCodeBlocks(root: HTMLElement): void {
	for (const pre of Array.from(root.querySelectorAll("pre"))) {
		if (pre.parentElement?.classList.contains(WRAP_CLASS)) continue;
		// A ```mermaid fence is on its way to becoming a diagram (MarkdownBody
		// upgrades it asynchronously, after this has run). Its source is not
		// what anyone wants on the clipboard, and the diagram that replaces it
		// carries its own control.
		if (pre.querySelector('code[class*="language-mermaid"]')) continue;
		const wrap = document.createElement("div");
		wrap.className = WRAP_CLASS;
		wrap.dataset.wrapped = "true";

		const controls = document.createElement("div");
		controls.className = CONTROLS_CLASS;

		const copyButton = document.createElement("button");
		copyButton.type = "button";
		copyButton.className = COPY_BUTTON_CLASS;
		copyButton.title = COPY_LABEL;
		copyButton.setAttribute("aria-label", COPY_LABEL);
		// Both glyphs are always in the DOM, stacked in one grid cell, so the
		// swap to the check has no layout in it and cannot shift the button.
		copyButton.innerHTML =
			`<span class="md-code-copy-glyph" data-state="idle">${copyIconMarkup()}</span>` +
			`<span class="md-code-copy-glyph" data-state="done">${checkIconMarkup()}</span>`;

		const wrapButton = document.createElement("button");
		wrapButton.type = "button";
		wrapButton.className = WRAP_BUTTON_CLASS;
		wrapButton.title = "Turn off code wrapping";
		wrapButton.setAttribute("role", "switch");
		wrapButton.setAttribute("aria-label", WRAP_LABEL);
		wrapButton.setAttribute("aria-checked", "true");

		pre.replaceWith(wrap);
		controls.append(copyButton, wrapButton);
		wrap.append(pre, controls);
	}
}

/**
 * Listen for code-control clicks under `root`. Delegated because the buttons
 * are created and destroyed by innerHTML rewrites; real buttons also turn
 * keyboard Enter and Space into the same click, so this is the whole
 * interaction. Returns the detach function.
 */
export function attachCodeCopy(root: HTMLElement): () => void {
	function onClick(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		const wrapButton = target?.closest?.(`button.${WRAP_BUTTON_CLASS}`) as
			| HTMLElement
			| null;
		if (wrapButton && root.contains(wrapButton)) {
			const wrap = wrapButton.closest(`.${WRAP_CLASS}`) as HTMLElement | null;
			if (!wrap) return;
			const wrapped = wrap.dataset.wrapped !== "false";
			wrap.dataset.wrapped = String(!wrapped);
			wrapButton.setAttribute("aria-checked", String(!wrapped));
			wrapButton.title = wrapped
				? "Turn on code wrapping"
				: "Turn off code wrapping";
			e.preventDefault();
			return;
		}

		const copyButton = target?.closest?.(`button.${COPY_BUTTON_CLASS}`) as
			| HTMLElement
			| null;
		if (!copyButton || !root.contains(copyButton)) return;
		const pre = copyButton.closest(`.${WRAP_CLASS}`)?.querySelector("pre");
		if (!pre) return;
		e.preventDefault();
		copyToClipboard(codeText(pre as HTMLElement), () =>
			flashCopied(copyButton),
		);
	}
	root.addEventListener("click", onClick);
	return () => root.removeEventListener("click", onClick);
}
