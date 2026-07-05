import { describe, expect, test } from "bun:test";
import { composerHighlightHtml, needsComposerHighlight } from "./composer-highlight";

describe("composerHighlightHtml", () => {
	test("plain text passes through escaped", () => {
		expect(composerHighlightHtml("hello <b>world</b>")).toBe(
			"hello &lt;b&gt;world&lt;/b&gt;​",
		);
	});

	test("inline code", () => {
		expect(composerHighlightHtml("run `bun test` now")).toBe(
			'run <span class="cmp-code">`bun test`</span> now​',
		);
	});

	test("closed fence keeps backticks and skips inline parsing inside", () => {
		expect(composerHighlightHtml("see:\n```ts\nconst `x` = 1;\n```\ndone")).toBe(
			'see:\n<span class="cmp-fence">```ts\nconst `x` = 1;\n```</span>\ndone​',
		);
	});

	test("open-ended fence (still typing) styles to end of draft", () => {
		expect(composerHighlightHtml("```bash\necho hi")).toBe(
			'<span class="cmp-fence">```bash\necho hi</span>​',
		);
	});

	test("empty inline backticks are not code", () => {
		expect(composerHighlightHtml("a `` b")).toBe("a `` b​");
	});

	test("inline code never spans lines", () => {
		expect(composerHighlightHtml("a `x\ny` b")).toBe("a `x\ny` b​");
	});

	test("escapes html inside code", () => {
		expect(composerHighlightHtml("`<img>`")).toBe(
			'<span class="cmp-code">`&lt;img&gt;`</span>​',
		);
	});
});

describe("needsComposerHighlight", () => {
	test("only when a backtick is present", () => {
		expect(needsComposerHighlight("plain")).toBe(false);
		expect(needsComposerHighlight("has `code`")).toBe(true);
	});
});
