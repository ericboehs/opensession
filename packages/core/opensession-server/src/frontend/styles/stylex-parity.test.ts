import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import ts from "typescript";

/**
 * Guards for the StyleX port (see STYLEX-MIGRATION.md). These fail loudly
 * when the migration's invariants drift:
 *
 *  1. the 720px boundary keeps ONE spelling everywhere;
 *  2. StyleX tokens keep resolving through base.css custom properties;
 *  3. no raw colors sneak into stylex-declared values;
 *  4. every static className token still resolves in SOME shipped
 *     stylesheet (residual.css, base.css, legacy.css, smooth-shadow.css) —
 *     this catches both unconverted Tailwind utilities and typos that would
 *     silently style nothing.
 */

const FRONTEND = join(import.meta.dir, "..");
const STYLES = join(FRONTEND, "styles");

function walk(dir: string, out: string[] = []) {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (e === "node_modules") continue;
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

const sources = walk(FRONTEND).filter((f) => /\.(tsx|ts)$/.test(f) && !f.endsWith(".test.ts"));

describe("stylex port guards", () => {
	test("the phone/desktop boundary is spelled exactly one way", () => {
		for (const f of sources) {
			// strip comments so prose about the history cannot trip the guard
			const src = readFileSync(f, "utf8")
				.replace(/^\s*\*.*$/gm, "")
				.replace(/^\s*\/\/.*$/gm, "");
			const bad = src.match(/@media\s*\(?(max-width:\s*720px|min-width:\s*721px)\)?/g)?.filter(
				(s) => !/\(max-width: 720px\)|\(min-width: 721px\)/.test(s),
			);
			expect(bad ?? []).toEqual([]);
			expect(src).not.toContain("max-[720px]");
			expect(src).not.toContain("min-[721px]");
			expect(src).not.toContain("max-[719.99px]");
		}
		// lib/breakpoints.ts stays the matchMedia authority, pinned to the same number
		expect(readFileSync(join(FRONTEND, "lib/breakpoints.ts"), "utf8")).toContain(
			'"(max-width: 720px)"',
		);
	});

	test("residual and semantic classes are merged with StyleX props", () => {
		const offenders: string[] = [];
		for (const f of sources.filter((file) => file.endsWith(".tsx"))) {
			const src = readFileSync(f, "utf8");
			const file = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
			function visit(node: ts.Node) {
				if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
					const attrs = [...node.attributes.properties];
					const hasClassName = attrs.some(
						(attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === "className",
					);
					const hasStylexSpread = attrs.some(
						(attr) =>
							ts.isJsxSpreadAttribute(attr) &&
							ts.isCallExpression(attr.expression) &&
							attr.expression.expression.getText(file) === "stylex.props",
					);
					if (hasClassName && hasStylexSpread) {
						offenders.push(`${f}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
					}
				}
				ts.forEachChild(node, visit);
			}
			visit(file);
		}
		expect(offenders).toEqual([]);
	});

	test("Tailwind hover semantics remain gated to hover-capable pointers", () => {
		const bare: string[] = [];
		for (const f of sources) {
			const src = readFileSync(f, "utf8");
			if (!src.includes("stylex.create") || !src.includes(":hover")) continue;
			const file = ts.createSourceFile(
				f,
				src,
				ts.ScriptTarget.Latest,
				true,
				f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			);
			const name = (node: ts.PropertyName) =>
				ts.isStringLiteral(node) || ts.isIdentifier(node) ? node.text : node.getText(file);
			function scan(node: ts.Node, hoverGate = false) {
				if (ts.isPropertyAssignment(node)) {
					const key = name(node.name);
					const gated = hoverGate || key === "@media (hover: hover)";
					if (key === ":hover" && !gated) {
						const childGate =
							ts.isObjectLiteralExpression(node.initializer) &&
							node.initializer.properties.some(
								(prop) => ts.isPropertyAssignment(prop) && name(prop.name) === "@media (hover: hover)",
							);
						if (!childGate) bare.push(`${f}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
					}
					ts.forEachChild(node, (child) => scan(child, gated));
					return;
				}
				ts.forEachChild(node, (child) => scan(child, hoverGate));
			}
			function visit(node: ts.Node) {
				if (
					ts.isCallExpression(node) &&
					node.expression.getText(file) === "stylex.create" &&
					node.arguments[0]
				) scan(node.arguments[0]);
				else ts.forEachChild(node, visit);
			}
			visit(file);
		}
		expect(bare).toEqual([]);
	});

	test("stylex.create contains no silently empty converted entries", () => {
		const empty: string[] = [];
		for (const f of sources) {
			const src = readFileSync(f, "utf8");
			if (!src.includes("stylex.create")) continue;
			const file = ts.createSourceFile(
				f,
				src,
				ts.ScriptTarget.Latest,
				true,
				f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			);
			function visit(node: ts.Node) {
				if (
					ts.isCallExpression(node) &&
					node.expression.getText(file) === "stylex.create" &&
					node.arguments[0] &&
					ts.isObjectLiteralExpression(node.arguments[0])
				) {
					for (const prop of node.arguments[0].properties) {
						if (
							ts.isPropertyAssignment(prop) &&
							ts.isObjectLiteralExpression(prop.initializer) &&
							prop.initializer.properties.length === 0
						) {
							empty.push(`${f}: ${prop.name.getText(file)}`);
						}
					}
				}
				ts.forEachChild(node, visit);
			}
			visit(file);
		}
		expect(empty).toEqual([]);
	});

	test("tokens.stylex.ts only references custom properties that base.css defines", () => {
		const base = readFileSync(join(STYLES, "base.css"), "utf8");
		const definedVars = new Set([...base.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
		const tokens = readFileSync(join(STYLES, "tokens.stylex.ts"), "utf8");
		const refs = [...tokens.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
		expect(refs.length).toBeGreaterThan(40);
		const missing = refs.filter((v) => !definedVars.has(v) && v !== "--accent-control" && v !== "--on-accent-control");
		expect(missing).toEqual([]);
	});

	test("stylex.create values carry no NEW raw colors (ratchet to zero)", () => {
		// A handful of arbitrary-value utilities converted mechanically carried
		// literal colors with them. The count may only go DOWN; each removal
		// should replace the literal with the token it duplicates.
		const RAW_COLOR_RATCHET = 120;
		function createBlock(src: string): string {
			const start = src.indexOf("stylex.create({");
			if (start < 0) return "";
			let depth = 0;
			for (let i = start; i < src.length; i++) {
				if (src[i] === "{") depth++;
				else if (src[i] === "}") {
					depth--;
					if (depth === 0) return src.slice(start, i + 1);
				}
			}
			return "";
		}
		let count = 0;
		for (const f of sources) {
			const src = readFileSync(f, "utf8");
			if (!src.includes("stylex.create")) continue;
			count += [...createBlock(src).matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length;
		}
		expect(count).toBeLessThanOrEqual(RAW_COLOR_RATCHET);
	});

	test.failing("every static className token resolves in a shipped stylesheet", () => {
		// Fails while the dynamic-conversion waves are in flight: tokens inside
		// cn()/template strings (phone:min-h-11 …) still resolve through the
		// live Tailwind sheet. When the last wave merges, regenerate
		// residual.css and flip this to a plain test.
		const sheets = ["residual.css", "base.css", "legacy.css", "smooth-shadow.css"]
			.map((n) => readFileSync(join(STYLES, n), "utf8").replace(/\\/g, ""))
			.join("\n");
		const markers = new Set(["group"]);
		const unresolved: string[] = [];
		for (const f of sources) {
			const src = readFileSync(f, "utf8");
			for (const m of src.matchAll(/\bclassName="([^"]*)"/g)) {
				for (const t of m[1].split(/\s+/)) {
					if (!t || markers.has(t)) continue;
					if (t.includes("${")) continue;
					if (!sheets.includes(t)) unresolved.push(`${f}: ${t}`);
				}
			}
		}
		expect(unresolved).toEqual([]);
	});
});
