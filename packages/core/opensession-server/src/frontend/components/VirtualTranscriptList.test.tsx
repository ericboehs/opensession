import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	VirtualTranscriptList,
	shouldAdjustTranscriptScroll,
	type VirtualTranscriptItem,
	virtualTranscriptRange,
} from "./VirtualTranscriptList";

function item(index: number): VirtualTranscriptItem {
	return {
		key: `block-${index}`,
		anchorId: `entry-${index}`,
		entryIds: [`entry-${index}`],
		estimateSize: 80,
		content: <span>Block {index}</span>,
	};
}

describe("VirtualTranscriptList", () => {
	test("keeps the live-edge tail in the same virtual coordinate space", () => {
		expect(virtualTranscriptRange([10, 11], 40, 3)).toEqual([10, 11, 37, 38, 39]);
		expect(virtualTranscriptRange([0, 1], 2, 24)).toEqual([0, 1]);
	});

	test("keeps the viewport stable when measured rows above it resize", () => {
		expect(shouldAdjustTranscriptScroll(400, 600)).toBe(true);
		expect(shouldAdjustTranscriptScroll(600, 600)).toBe(true);
		expect(shouldAdjustTranscriptScroll(700, 600)).toBe(false);
	});

	test("renders complete semantic content without browser measurement", () => {
		const html = renderToStaticMarkup(
			<VirtualTranscriptList
				items={[item(0), item(1), item(2)]}
				trailingMounted={1}
			/>,
		);
		expect(html).toContain("Block 0");
		expect(html).toContain("Block 2");
		expect(html).not.toContain("data-virtual-transcript");
	});
});
