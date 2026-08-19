import { describe, expect, test } from "bun:test";
import { mentionPaletteItems } from "./mention-palette";

describe("mentionPaletteItems", () => {
	const sessions = [
		{
			id: "current",
			title: "Current session",
			lastActivity: "2026-08-19T12:00:00Z",
		},
		{
			id: "recent",
			title: "Release follow-up",
			branch: "fix/release",
			repo: "opensession",
			lastActivity: "2026-08-19T11:00:00Z",
		},
		{
			id: "older",
			title: "Billing audit",
			branch: "audit/billing",
			lastActivity: "2026-08-18T11:00:00Z",
		},
		{
			id: "closed",
			title: "Archived",
			archived: true,
			lastActivity: "2026-08-19T13:00:00Z",
		},
	];

	test("lists every tool before recent active sessions for a bare trigger", () => {
		const rows = mentionPaletteItems({
			query: "",
			toolNames: ["slack", "linear", "linear"],
			sessions,
			currentSessionId: "current",
		});

		expect(rows.map((row) => `${row.kind}:${row.insert}`)).toEqual([
			"tool:linear",
			"tool:slack",
			"session:session:recent",
			"session:session:older",
		]);
	});

	test("filters tools and session metadata with the same query", () => {
		const rows = mentionPaletteItems({
			query: "bill",
			toolNames: ["slack", "billing-admin"],
			sessions,
		});

		expect(rows).toEqual([
			{
				display: "billing-admin",
				insert: "billing-admin",
				kind: "tool",
			},
			{
				display: "Billing audit",
				insert: "session:older",
				kind: "session",
				sub: "audit/billing",
			},
		]);
	});
});
