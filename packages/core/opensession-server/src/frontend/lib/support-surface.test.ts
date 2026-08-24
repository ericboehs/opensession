import { describe, expect, test } from "bun:test";
import {
	SUPPORT_SURFACE_OPTIONS,
	supportSurfaceOf,
	supportToolShown,
} from "./support-surface";

describe("supportSurfaceOf", () => {
	test("names each state the two underlying lists can be in", () => {
		expect(supportSurfaceOf(false, true)).toBe("sidebar");
		expect(supportSurfaceOf(true, false)).toBe("page");
		expect(supportSurfaceOf(false, false)).toBe("off");
	});

	// Adding the Support tool switched it on for every account that had ever
	// arranged its tools, on top of the band those accounts already had. Nobody
	// chose that, so it must not read as a third setting, and it must not put
	// the same queue on screen twice.
	test("both on is not a choice: it reads as the band, and the tool stays off", () => {
		expect(supportSurfaceOf(true, true)).toBe("sidebar");
		expect(supportToolShown(true, true)).toBe(false);
	});

	test("the tool is only up when it is the chosen surface", () => {
		expect(supportToolShown(true, false)).toBe(true);
		expect(supportToolShown(false, true)).toBe(false);
		expect(supportToolShown(false, false)).toBe(false);
	});

	test("every reachable state has a name to show for it", () => {
		const named = new Set(SUPPORT_SURFACE_OPTIONS.map((option) => option.value));
		for (const tool of [true, false])
			for (const band of [true, false])
				expect(named.has(supportSurfaceOf(tool, band))).toBe(true);
	});
});
