import { describe, expect, it } from "bun:test";
import { shortModelLabel, workspacePresetLabel } from "./ModelEffortSelect";
import type { ModelOption } from "../lib/api";

const models = [
	{
		id: "workspace-preset/ws-1111/opus-fable",
		provider: "opencode",
		label: "Opus 5 + Fable oracle",
		aliases: [],
	},
	{
		id: "opencode/anthropic/claude-sonnet-5",
		provider: "opencode",
		label: "Claude Sonnet 5",
		aliases: [],
	},
] as unknown as ModelOption[];

describe("workspace preset labels", () => {
	it("names the preset in its own workspace", () => {
		expect(shortModelLabel("workspace-preset/ws-1111/opus-fable", models)).toBe(
			"Opus 5 + Fable oracle",
		);
	});

	// A session can run a preset defined elsewhere (/model, a carried default)
	// while the catalog only ever holds its own workspace's presets.
	it("names a preset the catalog holds under another workspace", () => {
		expect(shortModelLabel("workspace-preset/ws-2222/opus-fable", models)).toBe(
			"Opus 5 + Fable oracle",
		);
	});

	it("falls back to the preset slug, never the storage path", () => {
		expect(shortModelLabel("workspace-preset/ws-2222/dial-ultra", models)).toBe(
			"Dial Ultra",
		);
		expect(shortModelLabel("pi/workspace-preset/ws-2222/dial-ultra", models)).toBe(
			"Dial Ultra",
		);
	});

	// The engine is routing, never part of a model's name.
	it("names an engine-routed id after its base entry", () => {
		expect(shortModelLabel("claude/workspace-preset/ws-1111/opus-fable", models)).toBe(
			"Opus 5 + Fable oracle",
		);
		expect(shortModelLabel("claude/anthropic/claude-sonnet-5", models)).toBe("Sonnet 5");
		expect(shortModelLabel("codex/openai/gpt-5.6-sol", models)).toBe("GPT-5.6 Sol");
		expect(shortModelLabel("opencode/openai/gpt-5.6-terra", models)).toBe(
			"GPT-5.6 Terra",
		);
		expect(shortModelLabel("opencode/openai/gpt-5.6-luna", models)).toBe(
			"GPT-5.6 Luna",
		);
		expect(shortModelLabel("opencode/cerebras/zai-glm-4.7", models)).toBe(
			"Z.ai GLM-4.7",
		);
		expect(shortModelLabel("opencode/wafer/glm-5.2", models)).toBe("GLM-5.2");
		expect(shortModelLabel("opencode/wafer/glm5.2-fast", models)).toBe(
			"GLM-5.2 Fast",
		);
		// An id with no catalog entry reads exactly as the unrouted one does —
		// the prefix goes, nothing else changes.
		expect(shortModelLabel("claude/dial/opus-fable", models)).toBe(
			shortModelLabel("dial/opus-fable", models),
		);
	});

	it("leaves plain model ids alone", () => {
		expect(workspacePresetLabel("opencode/anthropic/claude-sonnet-5", models)).toBeNull();
		expect(shortModelLabel("opencode/anthropic/claude-sonnet-5", models)).toBe("Sonnet 5");
	});
});
