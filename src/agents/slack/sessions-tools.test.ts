import { describe, expect, it } from "bun:test";
import { buildChildSessionPrompt } from "./sessions-tools";

describe("buildChildSessionPrompt", () => {
	it("adds parent report-back instructions for visible worker sessions", () => {
		const prompt = buildChildSessionPrompt({
			prompt: "Inspect the failing tests and summarize the fix.",
			parentSessionId: "bks-parent",
			reportBack: true,
		});

		expect(prompt).toContain("Inspect the failing tests");
		expect(prompt).toContain("worker session delegated by another Michael session");
		expect(prompt).toContain("report back to the parent/orchestrator session `bks-parent`");
		expect(prompt).toContain("send_to_session");
	});

	it("omits report-back instructions for standalone sessions", () => {
		const prompt = buildChildSessionPrompt({
			prompt: "Run a standalone investigation.",
			parentSessionId: "bks-parent",
			reportBack: false,
		});

		expect(prompt).toContain("Run a standalone investigation.");
		expect(prompt).not.toContain("send_to_session");
	});
});
