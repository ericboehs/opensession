import { expect, test } from "bun:test";
import {
	APP_HEADER_ACTIONS,
	ARCHIVED_SEARCH_HEADER,
	HEADER_TITLE_PILL,
	MOBILE_BACK,
	MOBILE_CONTROL_GLASS,
} from "../lib/app-header-classes";
import { TAB_STRIP } from "../lib/session-tab-classes";
import { REPORTS_COLUMN_HEADER } from "../lib/reports-classes";
import { infoTopbarClass } from "../lib/session-viewer-classes";

const CSS = new URL("./base.css", import.meta.url);

test("phone navigation chrome has no hard divider bars", async () => {
	const css = await Bun.file(CSS).text();

	expect(css).not.toMatch(
		/@media \(display-mode: standalone\)\s*\{\s*\.app\s*\{\s*border-top:/,
	);
	expect(TAB_STRIP).not.toContain("phone:border-b");
	expect(TAB_STRIP).not.toContain("phone:shadow-[");
	expect(infoTopbarClass(true)).not.toContain("border-b");
	expect(infoTopbarClass(false)).not.toContain("border-b");
	expect(REPORTS_COLUMN_HEADER).not.toMatch(/(?<!desktop:)border-b/);
});

test("archived search focus collapses the phone header without clipping its shadow", () => {
	expect(ARCHIVED_SEARCH_HEADER).not.toContain("overflow-hidden");
	expect(ARCHIVED_SEARCH_HEADER).toContain("safe-area-inset-top,0px),16px");
	expect(ARCHIVED_SEARCH_HEADER).toContain("+60px");
	expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:h-0!");
	expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:opacity-0");
	expect(ARCHIVED_SEARCH_HEADER).toContain(
		"phone:transition-[height,padding-top,opacity,transform]",
	);
	expect(ARCHIVED_SEARCH_HEADER).toContain("motion-reduce:transition-none");
});

test("every floating phone header control is made of the same glass", async () => {
	const css = await Bun.file(CSS).text();

	// The prefixed spelling is the whole point on iOS Safari and the installed
	// PWA, which still ship backdrop-filter only under `-webkit-`.
	expect(MOBILE_CONTROL_GLASS).toContain(
		"phone:[-webkit-backdrop-filter:var(--mobile-header-control-blur)]",
	);
	for (const control of [MOBILE_BACK, HEADER_TITLE_PILL, APP_HEADER_ACTIONS]) {
		expect(control).toContain(MOBILE_CONTROL_GLASS);
		// A page-coloured fill is what made these read as paper stickers.
		expect(control).not.toContain("phone:bg-surface");
	}

	// Glass is an enhancement: both opt-outs collapse the fill back to opaque.
	const optOuts = css.match(
		/--mobile-header-control-surface: var\(--bg\);/g,
	);
	expect(optOuts?.length).toBe(2);
});
