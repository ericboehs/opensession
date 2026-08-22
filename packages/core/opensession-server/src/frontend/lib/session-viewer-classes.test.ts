import { expect, test } from "bun:test";
import {
	VIEWER_HEADER_ACTIONS,
	VIEWER_INPUT,
} from "./session-viewer-classes";

test("the desktop tab strip cannot cover the header actions", () => {
	expect(VIEWER_HEADER_ACTIONS).toContain("relative z-[1]");
});

test("the focused phone composer does not double-count the keyboard pan", () => {
	// Safari pans this in-flow composer above the keyboard when its textarea
	// focuses. Keep the visual gap, but do not add the keyboard height again.
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:pb-3");
	expect(VIEWER_INPUT).not.toContain("var(--kb-inset");
});
