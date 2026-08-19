import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";

// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it or depending on test order.
Object.assign(
	((globalThis as unknown as { window?: Record<string, unknown> }).window ??= {}),
	{
		addEventListener: () => {},
		removeEventListener: () => {},
		matchMedia: () => ({ matches: false }),
	},
);
Object.assign(
	((globalThis as unknown as { document?: Record<string, unknown> }).document ??=
		{}),
	{
		documentElement: { dataset: {}, style: {} },
		querySelector: () => null,
		addEventListener: () => {},
		removeEventListener: () => {},
	},
);
Object.assign(
	((globalThis as unknown as { localStorage?: Record<string, unknown> })
		.localStorage ??= {}),
	{
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	},
);

const { ToolSection } = await import("./TurnBlock");

function toolUse(
	id: string,
	toolName: string,
	toolInput: unknown,
): TranscriptEntry {
	return {
		id,
		type: "tool_use",
		content: "",
		timestamp: "2026-08-17T09:00:00.000Z",
		toolName,
		toolUseId: `use-${id}`,
		toolInput,
	} as TranscriptEntry;
}

function result(
	forId: string,
	extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
	return {
		id: `res-${forId}`,
		type: "tool_result",
		content: "done",
		timestamp: "2026-08-17T09:00:01.000Z",
		toolUseId: `use-${forId}`,
		...extra,
	} as TranscriptEntry;
}

function edit(id: string, oldString: string, newString: string) {
	return toolUse(id, "Edit", {
		file_path: "src/x.ts",
		old_string: oldString,
		new_string: newString,
	});
}

function render(
	items: TranscriptEntry[],
	toolResults: Map<string, TranscriptEntry>,
	live = false,
) {
	return renderToStaticMarkup(
		React.createElement(ToolSection, {
			items,
			toolResults,
			live,
			expandAll: false,
		}),
	);
}

// The grouped row's numbers are cached per run, keyed on the run's last entry,
// so these all read through the cache: the point of each case is that a hit is
// only taken when nothing the row reports has moved.
describe("grouped tool run row", () => {
	test("reports the run's steps, tools and line counts", () => {
		const items = [toolUse("a", "Bash", { command: "ls" }), edit("b", "x", "y\nz")];
		const html = render(items, new Map());

		expect(html).toContain("2 step");
		expect(html).toContain("Bash · Edit");
		expect(html).toContain("+2");
		expect(html).toContain("-1");
	});

	test("picks up a result that arrives for an unchanged run", () => {
		// Same entry objects, so the cache key hits. The failure must still appear,
		// which is why the looked-up results are compared on a hit.
		const items = [
			toolUse("fail-a", "Bash", { command: "ls" }),
			toolUse("fail-b", "Bash", { command: "false" }),
		];
		expect(render(items, new Map())).not.toContain("failed");

		const withError = new Map([["use-fail-b", result("fail-b", { isError: true })]]);
		const html = render(items, withError);

		expect(html).toContain("1 failed");
	});

	test("picks up media a result carries for an unchanged run", () => {
		const items = [
			toolUse("media-a", "Bash", { command: "ls" }),
			toolUse("media-b", "Read", { file_path: "shot.png" }),
		];
		expect(render(items, new Map())).not.toContain("image");

		const withImage = new Map([
			["use-media-b", result("media-b", { images: ["/media?path=/tmp/a.png"] })],
		]);

		expect(render(items, withImage)).toContain("1 image");
	});

	test("re-derives when an earlier call is replaced but the last one stands", () => {
		// mergeTranscriptEntries replaces an entry rather than mutating it, and a
		// call earlier in the run can be replaced while the last one is untouched.
		// That is the case a cache keyed on the last entry alone would get wrong.
		const last = edit("keep", "a", "b");
		// One line each way per edit, so the run stands at +2/-2 to start with.
		const before = [edit("grow", "one", "two"), last];
		expect(render(before, new Map())).toContain(">+2<");

		// The replaced call now writes three lines instead of one.
		const after = [edit("grow", "one", "two\nthree\nfour"), last];
		const html = render(after, new Map());

		expect(html).toContain(">+4<");
		expect(html).toContain(">-2<");
	});

	test("counts a step with no result as running only while live", () => {
		const items = [
			toolUse("live-a", "Bash", { command: "sleep 1" }),
			toolUse("live-b", "Bash", { command: "sleep 2" }),
		];

		expect(render(items, new Map(), false)).not.toContain("running");
		expect(render(items, new Map(), true)).toContain("running");
	});

	test("renders identically for identical inputs", () => {
		const items = [toolUse("same-a", "Bash", { command: "ls" }), edit("same-b", "x", "y")];
		const results = new Map([["use-same-a", result("same-a")]]);

		expect(render(items, results)).toBe(render(items, results));
	});
});
