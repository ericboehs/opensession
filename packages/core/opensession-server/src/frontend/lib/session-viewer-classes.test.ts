import { expect, test } from "bun:test";
import {
	VIEWER_HEADER_ACTIONS,
	VIEWER_INPUT,
} from "./session-viewer-classes";

test("the desktop tab strip cannot cover the header actions", () => {
	expect(VIEWER_HEADER_ACTIONS).toContain("relative z-[1]");
});

test("the focused phone composer is fixed to the keyboard edge", () => {
	// Do not leave placement to Safari's focus pan: anchor the input to the
	// viewport. Fixed bottom already follows the visible keyboard edge, so adding
	// the measured keyboard height again would lift the composer far above it.
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:fixed");
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:bottom-0");
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:pb-3");
	expect(VIEWER_INPUT).not.toContain("var(--kb-inset");
});
