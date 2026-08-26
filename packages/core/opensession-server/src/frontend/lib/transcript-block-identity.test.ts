import { describe, expect, test } from "bun:test";
import {
	newTailBlockKeys,
	turnMountKey,
	turnScrollAnchor,
} from "./transcript-block-identity";

const entry = (id: string) => ({ id });

describe("transcript turn identity", () => {
	test("keeps the mounted component when live steps append", () => {
		expect(turnMountKey([entry("first"), entry("second")])).toBe(
			turnMountKey([entry("first"), entry("second"), entry("third")]),
		);
	});

	test("keeps the scroll anchor when history entries prepend", () => {
		expect(turnScrollAnchor([entry("second"), entry("third")])).toBe(
			turnScrollAnchor([entry("first"), entry("second"), entry("third")]),
		);
	});
});

describe("newTailBlockKeys", () => {
	const keys = (names: string[]) => names;

	test("first build seeds without animating", () => {
		expect(newTailBlockKeys(null, keys(["a", "b", "c", "d"]))).toEqual([]);
	});

	test("a new tail block arrives", () => {
		const previous = new Set(keys(["a", "b", "c"]));
		expect(newTailBlockKeys(previous, keys(["a", "b", "c", "d"]))).toEqual([
			"d",
		]);
	});

	test("history prepending at the head never animates", () => {
		const previous = new Set(keys(["a", "b", "c"]));
		expect(newTailBlockKeys(previous, keys(["x", "y", "a", "b", "c"]))).toEqual(
			[],
		);
	});

	test("several tail blocks mounting in one build arrive together", () => {
		const previous = new Set(keys(["a", "b"]));
		expect(
			newTailBlockKeys(previous, keys(["a", "b", "c", "d", "e"])),
		).toEqual(["c", "d", "e"]);
	});

	test("re-renders with unchanged keys do not re-animate", () => {
		const previous = new Set(keys(["a", "b", "c"]));
		expect(newTailBlockKeys(previous, keys(["a", "b", "c"]))).toEqual([]);
	});
});
