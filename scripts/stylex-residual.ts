/**
 * Generate styles/residual.css: the exact compiled Tailwind rules for every
 * class token still present in frontend markup that StyleX cannot express
 * (data-[…] variants, group-*, arbitrary selectors, structural pseudos,
 * container queries, component classes shipped by stylesheets…).
 *
 * Rules are copied VERBATIM from the compiled sheet — parity by construction;
 * this stylesheet is hand-editable afterwards, one comment per section.
 *
 * Run after conversions, before cutover:
 *   ./node_modules/.bin/tailwindcss -i packages/core/opensession-server/src/frontend/styles/tailwind.css -o /tmp/tw-current.css
 *   bun scripts/stylex-residual.ts [/tmp/tw-current.css] [--write]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FRONTEND = join(import.meta.dir, "../packages/core/opensession-server/src/frontend");
const SHEET = process.argv.find((a) => a.endsWith(".css")) ?? "/tmp/tw-current.css";
const WRITE = process.argv.includes("--write");

// ── collect every class token left in markup ────────────────────────────────
function walkFiles(dir: string, out: string[] = []) {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		const st = statSync(p);
		if (st.isDirectory()) walkFiles(p, out);
		else if (/\.(tsx|ts|html)$/.test(e)) out.push(p);
	}
	return out;
}

const tokens = new Set<string>();
for (const f of walkFiles(FRONTEND)) {
	const src = readFileSync(f, "utf8");
	if (src.includes("@stylexjs/stylex") === false && !f.endsWith(".html")) {
		// files without stylex may still carry classes through cn() constants
	}
	for (const m of src.matchAll(/\bclassName="([^"]*)"/g)) {
		for (const t of m[1].split(/\s+/)) if (t) tokens.add(t);
	}
	for (const m of src.matchAll(/className=\{`([^`]*)`\}/g)) {
		for (const raw of m[1].split(/\s+/)) {
			const t = raw.replace(/\$\{[^}]*\}/g, "").trim();
			if (t) tokens.add(t);
		}
	}
	// quoted strings inside cn()/constants: keep anything that could be a
	// utility; the sheet-intersection below is the real authority.
	for (const m of src.matchAll(/"([^"\n]{2,160})"/g)) {
		for (const t of m[1].split(/\s+/)) {
			if (!/^[a-zA-Z@[[]/.test(t)) continue;
			if (!/[-:\]]/.test(t)) continue;
			tokens.add(t);
		}
	}
}

/** Class names present in the compiled sheet (the utility authority). */
function sheetClassNames(sheetText: string): Set<string> {
	const names = new Set<string>();
	// strip at-rules bodies we do not need; selectors only
	for (const m of sheetText.matchAll(/([.#])([A-Za-z_@\][^\s{},>~+:#()[\]]*)/g)) {
		void m;
	}
	for (const line of sheetText.split(/[{;]/)) {
		const sel = line.trim().replace(/\\/g, "").replace(/}/g, "");
		for (const part of sel.split(",")) {
			for (const mm of part.matchAll(/[.]([A-Za-z_@][^\s:,>~+#]*)/g)) {
				names.add(mm[1]);
			}
		}
	}
	return names;
}

// ── walk the compiled sheet, keep matched rules verbatim ────────────────────
const src = readFileSync(SHEET, "utf8");
// Drop candidates the sheet has never heard of: component classes styled
// elsewhere (markdown, mono-input…) and prose strings.
const sheetNames = sheetClassNames(src);
for (const t of [...tokens]) {
	if (!sheetNames.has(t) && !t.includes(":")) tokens.delete(t);
	else if (!sheetNames.has(t) && t.includes(":")) {
		// variant tokens appear escaped+prefixed in the sheet; check base too
		const base = t.split(":").pop()!;
		if (!sheetNames.has(base)) tokens.delete(t);
	}
}
const kept: string[] = [];
let matchedTokens = new Set<string>();

/** Escape a class token the way Tailwind escapes selectors. */
function esc(t: string): string {
	return t.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function consider(selText: string): boolean {
	for (const t of tokens) {
		if (matchedTokens.has(t)) continue;
		const e = esc(t);
		const idx = selText.indexOf("." + e);
		if (idx >= 0) {
			const after = selText[idx + 1 + e.length];
			// must end at a selector boundary, not mid-name
			if (after === undefined || ":#[.>~+* ,(:){]".includes(after)) {
				matchedTokens.add(t);
				return true;
			}
		}
	}
	return false;
}

function wrappedRule(rule: string, wrappers: readonly string[]): string {
	let out = rule;
	for (let i = wrappers.length - 1; i >= 0; i--) out = `${wrappers[i]}{${out}}`;
	return out;
}

function walk(chunk: string, wrappers: readonly string[] = []) {
	let i = 0;
	while (i < chunk.length) {
		const open = chunk.indexOf("{", i);
		if (open < 0) break;
		const selRaw = chunk.slice(i, open).trim();
		let depth = 1;
		let j = open + 1;
		while (j < chunk.length && depth > 0) {
			if (chunk[j] === "{") depth++;
			else if (chunk[j] === "}") depth--;
			j++;
		}
		const body = chunk.slice(open, j); // includes braces
		if (selRaw.startsWith("@")) {
			if (selRaw.startsWith("@media") || selRaw.startsWith("@supports")) {
				walk(chunk.slice(open + 1, j - 1), [...wrappers, selRaw]);
			} else if (
				selRaw.startsWith("@property") ||
				selRaw.startsWith("@keyframes") ||
				selRaw.startsWith("@container")
			) {
				kept.push(wrappedRule(selRaw + body, wrappers));
			}
			i = j;
			continue;
		}
		if (consider(selRaw)) kept.push(wrappedRule(selRaw + body, wrappers));
		i = j;
	}
}
walk(src);

// Unmatched tokens: mostly component classes styled by base.css/legacy.css
// (markdown, mono-input…) or already-converted tokens — report, don't fail.
const unmatched = [...tokens].filter((t) => !matchedTokens.has(t));

const header = `/* ─────────────────────────────────────────────────────────────
   residual.css — the Tailwind rules StyleX cannot express, kept
   verbatim from the last compiled utilities sheet so behavior is
   identical by construction. Generated by scripts/stylex-residual.ts
   (${kept.length} rules for ${matchedTokens.size} class tokens); hand-editable after
   this point. Classes referenced here stay in markup alongside
   stylex.props spreads — see styles/STYLEX-MIGRATION.md.
   ───────────────────────────────────────────────────────────── */

`;
const outCss = header + kept.join("\n") + "\n";
if (WRITE) writeFileSync(join(FRONTEND, "styles/residual.css"), outCss);
console.log(`tokens seen: ${tokens.size}, matched: ${matchedTokens.size}, rules kept: ${kept.length}, bytes: ${outCss.length}`);
console.log(`unmatched (component classes / already handled): ${unmatched.length}`);
if (process.env.SHOW_UNMATCHED) console.log(unmatched.join(" "));
