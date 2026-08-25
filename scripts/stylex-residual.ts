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
import ts from "typescript";

const FRONTEND = join(import.meta.dir, "../packages/core/opensession-server/src/frontend");
const SHEET = process.argv.find((a) => a.endsWith(".css")) ?? "/tmp/tw-current.css";
const WRITE = process.argv.includes("--write");

// ── collect every class token left in markup ────────────────────────────────
function walkFiles(dir: string, out: string[] = []) {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		const st = statSync(p);
		if (st.isDirectory()) walkFiles(p, out);
		else if (/\.(tsx|ts|html)$/.test(e) && !e.includes(".test.")) out.push(p);
	}
	return out;
}

const tokens = new Set<string>();
const add = (text: string) => {
	for (const token of text.split(/\s+/)) if (token) tokens.add(token);
};

let valueDeclarations = new Map<string, ts.Expression>();
let functionReturns = new Map<string, ts.Expression[]>();
const resolving = new Set<string>();

function collectResolved(node: ts.Node, file: ts.SourceFile): void {
	if (ts.isObjectLiteralExpression(node)) {
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) collectClassValue(prop.initializer, file);
		}
		return;
	}
	collectClassValue(node, file);
}

/** Walk only positions that can produce a class value. In particular, do not
 * recursively harvest every string below cn(): `mode === "hover"` is state,
 * not a class, and StyleX declaration values such as "flex" are not markup. */
function collectClassValue(node: ts.Node, file: ts.SourceFile): void {
	if (ts.isStringLiteralLike(node)) {
		add(node.text);
		return;
	}
	if (ts.isIdentifier(node)) {
		const value = valueDeclarations.get(node.text);
		if (value && !resolving.has(node.text)) {
			resolving.add(node.text);
			collectResolved(value, file);
			resolving.delete(node.text);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
		collectClassValue(node.expression, file);
		return;
	}
	if (ts.isCallExpression(node)) {
		const name = node.expression.getText(file);
		for (const result of functionReturns.get(name) ?? []) collectClassValue(result, file);
		return;
	}
	if (ts.isTemplateExpression(node)) {
		add(node.head.text);
		for (const span of node.templateSpans) {
			collectClassValue(span.expression, file);
			add(span.literal.text);
		}
		return;
	}
	if (ts.isConditionalExpression(node)) {
		collectClassValue(node.whenTrue, file);
		collectClassValue(node.whenFalse, file);
		return;
	}
	if (ts.isBinaryExpression(node)) {
		if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
			collectClassValue(node.right, file);
		} else if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			collectClassValue(node.left, file);
			collectClassValue(node.right, file);
		}
		return;
	}
	if (ts.isArrayLiteralExpression(node)) {
		for (const element of node.elements) collectClassValue(element, file);
		return;
	}
	if (ts.isObjectLiteralExpression(node)) {
		for (const prop of node.properties) {
			if (ts.isPropertyAssignment(prop)) add(prop.name.getText(file).replace(/^['"]|['"]$/g, ""));
		}
		return;
	}
	if (ts.isParenthesizedExpression(node)) collectClassValue(node.expression, file);
}

for (const f of walkFiles(FRONTEND)) {
	if (f.endsWith(".html")) {
		for (const match of readFileSync(f, "utf8").matchAll(/\bclass="([^"]*)"/g)) add(match[1]);
		continue;
	}
	const text = readFileSync(f, "utf8");
	const file = ts.createSourceFile(
		f,
		text,
		ts.ScriptTarget.Latest,
		true,
		f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	valueDeclarations = new Map();
	functionReturns = new Map();
	function index(node: ts.Node) {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			valueDeclarations.set(node.name.text, node.initializer);
		}
		if (ts.isFunctionDeclaration(node) && node.name) {
			const returns: ts.Expression[] = [];
			function findReturn(child: ts.Node) {
				if (ts.isReturnStatement(child) && child.expression) returns.push(child.expression);
				else ts.forEachChild(child, findReturn);
			}
			if (node.body) findReturn(node.body);
			functionReturns.set(node.name.text, returns);
		}
		ts.forEachChild(node, index);
	}
	index(file);
	function visit(node: ts.Node) {
		if (ts.isCallExpression(node)) {
			const name = node.expression.getText(file);
			if (name === "mergeStylexClassName" || name === "mergeStylexProps") {
				if (node.arguments[0]) collectClassValue(node.arguments[0], file);
				return;
			}
			if (name === "cn" || name === "clsx") {
				for (const arg of node.arguments) collectClassValue(arg, file);
				return;
			}
		}
		if (ts.isJsxAttribute(node) && node.name.getText(file) === "className" && node.initializer) {
			if (ts.isStringLiteral(node.initializer)) add(node.initializer.text);
			else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
				collectClassValue(node.initializer.expression, file);
			}
			return;
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
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
for (const token of [...tokens]) {
	const escaped = token.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
	if (!src.includes(`.${escaped}`) && !sheetNames.has(token)) tokens.delete(token);
}

const semanticHooks = new Set([
	"app",
	"app-body",
	"app-header-actions",
	"archived-row",
	"detail-pane",
	"session-info-status",
	"session-tab-new",
	"session-tab-reorder",
	"session-tab-view",
	"session-tabs",
	"staging-icon",
	"tool-pre",
	"viewer-header",
	"viewer-header-actions",
	"viewer-panel",
	"workspace-info-panel",
	"ws-summary-band",
]);
const isPermittedResidual = (token: string) =>
	token.startsWith("[") ||
	token.startsWith("phone:[") ||
	/^(?:data-|data-active|aria-|group(?:$|[/:-])|peer(?:$|-)|has-|selection:|first:|last:|empty:|-space-|space-y-|divide-|md:group-|phone:(?:\*|group-)|smooth-shadow|plate-sheen)/.test(
		token,
	) ||
	semanticHooks.has(token);
const convertible = [...tokens].filter((token) => !isPermittedResidual(token));
if (convertible.length > 0) {
	throw new Error(
		`StyleX-expressible classes remain outside StyleX:\n${convertible.sort().join("\n")}`,
	);
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
if (process.env.SHOW_TOKENS) console.log([...tokens].sort().join("\n"));
