import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
	listReportsForSession,
	REPORTS_ROOT,
	type ReportMeta,
} from "./reports";

const automationId = `test-session-reports-${process.pid}`;
const secondAutomationId = `${automationId}-second`;
const dirs = [
	join(REPORTS_ROOT, automationId),
	join(REPORTS_ROOT, secondAutomationId),
];

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("listReportsForSession", () => {
	test("returns only reports produced by the requested session, newest first", () => {
		for (const dir of dirs) mkdirSync(dir, { recursive: true });
		const reports: ReportMeta[] = [
			{
				id: "older",
				title: "Older",
				automationId,
				automationName: "Test",
				sessionId: "bks-target",
				createdAt: "2026-07-19T10:00:00.000Z",
			},
			{
				id: "newer",
				title: "Newer",
				automationId,
				automationName: "Test",
				sessionId: "bks-target",
				createdAt: "2026-07-20T10:00:00.000Z",
			},
			{
				id: "other",
				title: "Other",
				automationId,
				automationName: "Test",
				sessionId: "bks-other",
				createdAt: "2026-07-21T10:00:00.000Z",
			},
			{
				id: "newer",
				title: "Same id, another automation",
				automationId: secondAutomationId,
				automationName: "Second test",
				sessionId: "bks-target",
				createdAt: "2026-07-22T10:00:00.000Z",
			},
		];
		for (const report of reports) {
			const dir = join(REPORTS_ROOT, report.automationId);
			writeFileSync(join(dir, `${report.id}.json`), JSON.stringify(report));
		}

		expect(
			listReportsForSession("bks-target").map(
				(report) => `${report.automationId}/${report.id}`,
			),
		).toEqual([
			`${secondAutomationId}/newer`,
			`${automationId}/newer`,
			`${automationId}/older`,
		]);
	});
});
