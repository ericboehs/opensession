import { expect, test } from "bun:test";

test("every new-session palette opener primes the phone keyboard", async () => {
	const app = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
	const setterStart = app.indexOf("const [palette, setPaletteState]");
	const setterEnd = app.indexOf("// Bumped by the sidebar's draft row", setterStart);
	const setter = app.slice(setterStart, setterEnd);

	expect(setterStart).toBeGreaterThan(-1);
	expect(setter).toContain("if (next.open) primeSoftKeyboard();");
	// App may open the palette from the global +, a workspace row, a repo band,
	// or a prefilled link. No direct replacement state may bypass the
	// keyboard-aware setter. Functional updates are reserved for restoring an
	// already-open palette after an asynchronous create failure.
	expect(app).not.toMatch(/\bsetPaletteState\s*\(\s*\{/);

	const repoOpenStart = app.indexOf("onNewSessionInRepo={(repo)");
	const repoOpenEnd = app.indexOf("showDraftRow=", repoOpenStart);
	const repoOpen = app.slice(repoOpenStart, repoOpenEnd);
	expect(repoOpenStart).toBeGreaterThan(-1);
	expect(repoOpen).toContain("setPalette(");
});
