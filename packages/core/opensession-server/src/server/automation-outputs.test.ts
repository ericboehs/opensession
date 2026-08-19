import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import {
	deleteAutomationOutputState,
	deliverAutomationOutputs,
	sanitizeAutomationOutputs,
} from "./automation-outputs";
import { __resetReportIndexForTest, publishReport, REPORTS_ROOT } from "./reports";

const automationId = `test-automation-outputs-${process.pid}`;

afterEach(() => {
	deleteAutomationOutputState(automationId);
	rmSync(join(REPORTS_ROOT, automationId), { recursive: true, force: true });
	__resetReportIndexForTest();
});

describe("sanitizeAutomationOutputs", () => {
	test("normalizes report and disabled Slack sinks", () => {
		expect(
			sanitizeAutomationOutputs([
				{ id: "report", type: "report", publish: "on_findings" },
				{
					id: "slack",
					type: "slack",
					enabled: false,
					channel: "c01ed50a2kg",
				},
			]),
		).toEqual([
			{ id: "report", type: "report", enabled: true, publish: "on_findings" },
			{
				id: "slack",
				type: "slack",
				enabled: false,
				channel: "C01ED50A2KG",
				source: "report",
				minUrgency: "high",
				minConfidence: "high",
			},
		]);
	});

	test("rejects channel names and duplicate ids", () => {
		expect(
			sanitizeAutomationOutputs([
				{ id: "slack", type: "slack", channel: "#chat" },
			]),
		).toEqual({ error: "outputs[0].channel must be a Slack C…/G… channel id" });
		expect(
			sanitizeAutomationOutputs([
				{ id: "same", type: "report" },
				{ id: "same", type: "report" },
			]),
		).toEqual({ error: 'duplicate automation output id "same"' });
	});
});

describe("deliverAutomationOutputs", () => {
	test("does not require or deliver a disabled Slack sink", async () => {
		await expect(
			deliverAutomationOutputs({
				automationId,
				outputs: [
					{
						id: "slack",
						type: "slack",
						enabled: false,
						channel: "C01ED50A2KG",
					},
				],
				sessionId: "os-no-report",
				startedAt: new Date(),
			}),
		).resolves.toBeUndefined();
	});

	test("fails a required report output when the run did not publish", async () => {
		await expect(
			deliverAutomationOutputs({
				automationId,
				outputs: [{ id: "report", type: "report", publish: "always" }],
				sessionId: "os-no-report",
				startedAt: new Date(),
			}),
		).rejects.toThrow("Required report output was not published");
	});

	test("accepts a current report as the required durable output", async () => {
		const startedAt = new Date(Date.now() - 1000);
		publishReport({
			automationId,
			automationName: "Test",
			sessionId: "os-with-report",
			title: "Current report",
			html: "<p>ok</p>",
		});
		await expect(
			deliverAutomationOutputs({
				automationId,
				outputs: [{ id: "report", type: "report", publish: "always" }],
				sessionId: "os-with-report",
				startedAt,
			}),
		).resolves.toBeUndefined();
	});
});
