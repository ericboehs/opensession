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
	// viewport and lift it by exactly what the keyboard covers.
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:fixed");
	expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:bottom-0");
	expect(VIEWER_INPUT).toContain(
		"phone:[body.kb-open_&]:pb-[calc(12px+var(--kb-inset,0px))]",
	);
});
