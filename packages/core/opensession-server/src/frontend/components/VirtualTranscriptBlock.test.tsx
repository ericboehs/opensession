import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualTranscriptBlock } from "./VirtualTranscriptBlock";

const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(() => {
	if (originalIntersectionObserver === undefined) {
		delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
			.IntersectionObserver;
	} else {
		globalThis.IntersectionObserver = originalIntersectionObserver;
	}
});

describe("VirtualTranscriptBlock", () => {
	test("starts an observed history block as a lightweight placeholder", () => {
		globalThis.IntersectionObserver = class {} as unknown as typeof IntersectionObserver;

		const html = renderToStaticMarkup(
			<VirtualTranscriptBlock enabled anchorId="old-turn">
				<span>heavy transcript turn</span>
			</VirtualTranscriptBlock>,
		);

		expect(html).toContain('data-eid="old-turn"');
		expect(html).toContain("height:96px");
		expect(html).toContain("aria-hidden");
		expect(html).not.toContain("heavy transcript turn");
	});

	test("keeps recent blocks mounted", () => {
		globalThis.IntersectionObserver = class {} as unknown as typeof IntersectionObserver;

		const html = renderToStaticMarkup(
			<VirtualTranscriptBlock enabled={false} anchorId="recent-turn">
				<span>recent transcript turn</span>
			</VirtualTranscriptBlock>,
		);

		expect(html).toContain("recent transcript turn");
		expect(html).not.toContain("aria-hidden");
	});
});
