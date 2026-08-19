import { beforeEach, describe, expect, test } from "bun:test";
import {
	acknowledgePromptDispatch,
	beginPromptDispatch,
	promptDispatches,
	promptQueues,
	takeQueuedPrompt,
} from "./queue-state";

const SESSION = "os-queue-state-update-test";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
describe("takeQueuedPrompt", () => {
	beforeEach(() => {
		promptDispatches.clear();
		promptQueues.set(SESSION, [
			{
				id: "q1",
				content: "first",
				user: "Kent",
				images: [PNG],
				files: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
			},
			{ id: "q2", content: "second", user: "Michiel" },
		]);
	});

	test("keeps a selected prompt durable until the runner acknowledges it", () => {
		const promptEntryId = beginPromptDispatch(
			SESSION,
			[{ id: "q1", content: "first", user: "Kent" }],
			"entry-1",
			false,
		);
		expect(promptEntryId).toBe("entry-1");
		expect(promptDispatches.get(SESSION)).toEqual({
			promptEntryId: "entry-1",
			items: [{ id: "q1", content: "first", user: "Kent" }],
		});

		acknowledgePromptDispatch(SESSION, "other-entry", false);
		expect(promptDispatches.has(SESSION)).toBe(true);
		acknowledgePromptDispatch(SESSION, "entry-1", false);
		expect(promptDispatches.has(SESSION)).toBe(false);
	});

	test("atomically removes and returns the complete payload", () => {
		expect(takeQueuedPrompt(SESSION, "q1", "Kent de Bruin", false)).toMatchObject({
			id: "q1",
			content: "first",
			images: [PNG],
			files: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
		});
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["q2"]);
	});

	test("only the original sender can take a row", () => {
		expect(takeQueuedPrompt(SESSION, "q1", "Michiel", false)).toBeUndefined();
		expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["q1", "q2"]);
	});

	test("routed and context-carrying rows remain queue-owned", () => {
		promptQueues.set(SESSION, [
			{ id: "q1", content: "Slack", user: "Kent", slackReplyTo: { channel: "C1", threadTs: "1" } },
			{ id: "q2", content: "Context", user: "Kent", contextSessions: ["os-other"] },
		]);
		expect(takeQueuedPrompt(SESSION, "q1", "Kent", false)).toBeUndefined();
		expect(takeQueuedPrompt(SESSION, "q2", "Kent", false)).toBeUndefined();
	});
});
