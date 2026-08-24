/**
 * The StyleX compile pass.
 *
 * Bun cannot run Babel plugins natively, so — exactly like the Tailwind
 * subprocess in frontend-build.ts — the real compiler is invoked here over
 * every frontend file that imports @stylexjs/stylex, BEFORE the oxc React
 * Compiler pass rewrites the tree. Each file's compiled class names come back
 * through the plugin metadata and their CSS rules collect into one sheet,
 * which compileAssets() writes hashed next to the bundle.
 *
 * The transform is syntax-only apart from stylex.* calls: TypeScript is
 * stripped (Babel cannot re-emit it), JSX is preserved and handed to Bun with
 * the `jsx` loader, where the React Compiler pass picks it up unchanged.
 *
 * Dev mode (OPENSESSION_DEV=1) serves the UI through Bun's HMR server, which
 * has no plugin hook and therefore ships NO compiled styles — the same gap
 * styles/tailwind.css documented until 2026-08-05. The prod path with
 * in-process rebuilds is the dev loop.
 */
import { transformSync } from "@babel/core";
import stylexBabelPlugin from "@stylexjs/babel-plugin";
import { join, resolve } from "path";

const SERVER_ROOT = join(import.meta.dir, "..", "..");
/** Everything under this root that mentions @stylexjs/stylex gets compiled. */
const FRONTEND_SRC_STYLEX = resolve(SERVER_ROOT, "src", "frontend");

export type StylexCollector = {
	/** Compiled CSS rule text keyed by the class name that owns it, so the
	 *  same rule met twice merges instead of duplicating. Theme files
	 *  (:root variable definitions) arrive under their file hash. */
	rules: Map<string, string>;
};

export function newStylexCollector(): StylexCollector {
	return { rules: new Map() };
}

/**
 * Harvest compiled rules out of the babel plugin's metadata.
 *
 * The payload's shape is not something to trust across versions or bundler
 * contexts (observed both `[[className, rule], …]` arrays and flat spreads),
 * so walk it and take everything shaped like [className, {ltr, rtl?, …}]:
 * that pair is the one stable contract. Theme files contribute their
 * :root variable definitions the same way, keyed by file hash.
 */
function collectStylexRules(collector: StylexCollector, node: unknown): void {
	if (Array.isArray(node)) {
		const looksLikeRule =
			node.length >= 2 &&
			typeof node[0] === "string" &&
			!!node[1] &&
			typeof node[1] === "object" &&
			typeof (node[1] as { ltr?: unknown }).ltr === "string";
		if (looksLikeRule) {
			const [className, rule] = node as [string, { ltr?: string }];
			if (rule.ltr) collector.rules.set(className, rule.ltr);
			return;
		}
		for (const child of node) collectStylexRules(collector, child);
	} else if (node && typeof node === "object") {
		for (const child of Object.values(node as Record<string, unknown>)) {
			collectStylexRules(collector, child);
		}
	}
}

/** The stylesheet produced by one build: every collected rule in first-seen
 *  order (deterministic for identical inputs), ready to write hashed. */
export function stylexCss(collector: StylexCollector): string {
	return [...collector.rules.values()].join("\n");
}

/**
 * Transform ONE frontend source file through the StyleX compiler, collecting
 * its rules into the build's collector. Returns the source unchanged when the
 * file does not use StyleX. TypeScript syntax is PRESERVED — the caller hands
 * the result to the next pass (oxc React Compiler) with the original loader.
 */
export function stylexTransform(
	path: string,
	sourceText: string,
	collector: StylexCollector,
): string {
	if (!path.startsWith(FRONTEND_SRC_STYLEX)) return sourceText;
	if (!sourceText.includes("@stylexjs/stylex")) return sourceText;
	// The plugin's shipped types do not line up with @babel/core's; the
	// runtime contract is the standard [plugin, options] pair.
	const result = transformSync(sourceText, {
		filename: path,
		// Syntax only: nothing is stripped, JSX survives untouched.
		parserOpts: { plugins: ["typescript", "jsx"] },
		plugins: [
			[
				stylexBabelPlugin as never,
				{
					dev: false,
					runtimeInjection: false,
					genConditionalClasses: true,
					treeshakeCompensation: true,
					// Cross-file tokens (styles/tokens.stylex.ts) need the import
					// resolved to a canonical path; commonJS mode walks
					// node_modules-style relative paths, which is all the
					// frontend uses.
					unstable_moduleResolution: {
						type: "commonJS",
						rootDir: FRONTEND_SRC_STYLEX,
					},
				},
			],
		],
		configFile: false,
		babelrc: false,
	});
	if (!result?.code) return sourceText;
	const meta = (result.metadata ?? {}) as { stylex?: unknown };
	collectStylexRules(collector, meta.stylex);
	return result.code;
}
