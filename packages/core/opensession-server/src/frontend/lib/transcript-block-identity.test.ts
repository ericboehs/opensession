import { describe, expect, test } from "bun:test";
import { turnMountKey, turnScrollAnchor } from "./transcript-block-identity";

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
