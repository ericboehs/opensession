import { expect, test } from "bun:test";
import {
	VIEWER_HEADER_ACTIONS,
	VIEWER_INPUT,
} from "./session-viewer-classes";

test("the desktop tab strip cannot cover the header actions", () => {
	expect(VIEWER_HEADER_ACTIONS).toContain("relative z-[1]");
});

test("the focused phone composer rests on the keyboard, not behind it", () => {
	// 12px above the KEYBOARD's top edge: the column lives in the fixed
	// viewport, which iOS does not shrink, so the pad has to carry the
	// keyboard's own height or the composer lands under the keys.
	expect(VIEWER_INPUT).toContain(
		"phone:[body.kb-open_&]:pb-[calc(12px+var(--kb-inset,0px))]",
	);
	// The old rule only fired for an expanded composer, so a minimized one was
	// left holding a safe-area inset the keyboard had already covered.
	expect(VIEWER_INPUT).not.toContain("composer-min))]:pb-3");
});
