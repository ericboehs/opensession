import { describe, expect, test } from "bun:test";

const CSS = new URL("./base.css", import.meta.url);
const HTML = new URL("../index.html", import.meta.url);

describe("app viewport", () => {
	test("the app fills its viewport-locked body without remeasuring viewport units", async () => {
		const css = await Bun.file(CSS).text();
		const root = css.match(/#root\s*\{([^}]*)\}/)?.[1] ?? "";

		expect(css).toMatch(/body\s*\{\s*position:\s*fixed;\s*inset:\s*0;/);
		expect(root).toMatch(/height:\s*100%/);
		expect(root).not.toMatch(/height:\s*100(?:d|l|s)?vh/);
	});

	test("focused text fields release the physical-screen override for keyboard panning", async () => {
		const css = await Bun.file(CSS).text();

		expect(css).toMatch(
			/html:has\(body\.kb-open\),\s*body\.kb-open\s*\{[^}]*height:\s*100%\s*!important/,
		);
	});

	test("standalone iPhones expand both document roots to the physical screen", async () => {
		const html = await Bun.file(HTML).text();

		expect(html).toContain('matchMedia("(display-mode: standalone)").matches');
		expect(html).toContain("document.documentElement.style.height = height");
		expect(html).toContain("document.body.style.height = height");
		expect(html).toContain("window.screen.height");
		expect(html).toContain("keyboardOpen()");
	});

	test("the standalone correction does not trust WebKit's short innerHeight", async () => {
		const html = await Bun.file(HTML).text();

		// A short innerHeight is the iOS bug being corrected. Treating it as
		// evidence that the fill failed restores the letterboxed viewport.
		expect(html).not.toContain("window.innerHeight");
		expect(html).not.toContain('style.height = ""');
	});
});
