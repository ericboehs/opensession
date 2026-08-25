import { describe, expect, test } from "bun:test";
import { mergeStylexProps } from "./cn";

describe("mergeStylexProps", () => {
	test("keeps semantic or residual classes beside compiled StyleX classes", () => {
		const props = mergeStylexProps(
			["semantic-hook", false, "data-[open]:block"],
			{ color: "x-stylex-color", $$css: true } as never,
		);
		expect(props.className).toBe(
			"semantic-hook data-[open]:block x-stylex-color",
		);
	});
});
