import { describe, expect, test } from "bun:test";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnifiedSession } from "../../lib/types";

Object.assign(
	((globalThis as unknown as { window?: Record<string, unknown> }).window ??= {}),
	{
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => true,
		matchMedia: () => ({ matches: false }),
		setInterval: () => 0,
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
Object.assign(
	((globalThis as unknown as { document?: Record<string, unknown> }).document ??=
		{}),
	{
		documentElement: { dataset: {}, style: { colorScheme: "" } },
		querySelector: () => null,
		addEventListener: () => {},
		visibilityState: "visible",
	},
);

const { ActiveSubagentRows } = await import("./ActiveSubagentRows");

function session(
	id: string,
	overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
	return {
		id,
		claudeSessionId: null,
		source: "opensession",
		branch: null,
		worktreeDir: null,
		startedBy: "Michiel",
		title: `Worker ${id}`,
		lastActivity: "2026-08-18T10:00:00Z",
		createdAt: "2026-08-18T10:00:00Z",
		isRunning: true,
		transcriptPath: null,
		parentSessionId: "parent",
		...overrides,
	};
}

describe("ActiveSubagentRows", () => {
	test("renders semantic indented child rows and selected state", () => {
		const direct = session("direct");
		const nested = session("nested", { parentSessionId: "direct" });
		const html = renderToStaticMarkup(
			<ActiveSubagentRows
				items={[
					{ session: direct, depth: 1 },
					{ session: nested, depth: 2 },
				]}
				selectedId="nested"
				onSelect={() => {}}
			/>,
		);

		expect(html.match(/data-active-subagent-row/g)).toHaveLength(2);
		expect(html).toContain('data-parent-session-id="parent"');
		expect(html).toContain('data-parent-session-id="direct"');
		expect(html).toContain('aria-current="page"');
		// 41 is the workspace row's repo-tile column, so the arrow centres under
		// the tile rather than in the gap before it.
		expect(html).toContain("--sidebar-icon-left:41px");
		expect(html).toContain("--sidebar-icon-left:53px");
		expect(html).toContain("Worker nested, subagent, Running");
	});

	test("opens the exact child session", () => {
		const child = session("child");
		let opened: UnifiedSession | null = null;
		const tree = ActiveSubagentRows({
			items: [{ session: child, depth: 1 }],
			selectedId: null,
			onSelect: (session) => {
				opened = session;
			},
		}) as ReactElement<{ children: React.ReactNode }>;
		const button = React.Children.toArray(tree.props.children)[0] as ReactElement<{
			onClick: () => void;
		}>;
		button.props.onClick();
		expect((opened as UnifiedSession | null)?.id).toBe("child");
	});
});
