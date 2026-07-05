import React, { useEffect, useRef, useState } from "react";
import { effectiveTheme, onThemeChanged, type EffectiveTheme } from "../lib/theme";

/**
 * Rendered-markdown container that upgrades ```lang fences to shiki-highlighted
 * blocks after mount. Shiki is multi-MB, so it's only dynamically imported when
 * a message actually carries a language-tagged fence — plain messages render
 * the marked output untouched. Fences with no (or an unshipped) language keep
 * the stock .markdown <pre> styling.
 */
export function MarkdownBody({
	html,
	className,
}: {
	html: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [theme, setTheme] = useState<EffectiveTheme>(effectiveTheme);
	useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);

	useEffect(() => {
		// marked emits <code class="language-x"> only for tagged fences.
		if (!html.includes('<code class="language-')) return;
		const el = ref.current;
		if (!el) return;
		let alive = true;
		import("./CodeHighlight")
			.then(async (m) => {
				if (!alive || !ref.current) return;
				// Restore the pristine marked output first: a theme flip re-runs this
				// effect, and highlighting must start from the original fences, not
				// from the previous pass's shiki markup.
				ref.current.innerHTML = html;
				const blocks = Array.from(
					ref.current.querySelectorAll('pre > code[class*="language-"]'),
				);
				for (const code of blocks) {
					const lang = /language-([^\s"]+)/.exec(code.className)?.[1];
					if (!lang) continue;
					const out = await m.highlightToHtml(code.textContent ?? "", lang);
					const pre = code.parentElement;
					if (!alive || !out || !pre || !ref.current?.contains(pre)) continue;
					const tpl = document.createElement("template");
					tpl.innerHTML = out;
					const shikiPre = tpl.content.firstElementChild;
					if (shikiPre) {
						shikiPre.classList.add("md-code");
						pre.replaceWith(shikiPre);
					}
				}
			})
			.catch(() => {}); // highlight is progressive enhancement — plain pre stays
		return () => {
			alive = false;
		};
	}, [html, theme]);

	return (
		<div
			ref={ref}
			className={className}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
