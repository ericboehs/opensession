import { describe, expect, it } from "bun:test";
import {
	baseModelId,
	engineModelId,
	isAnthropicModel,
	modelEngine,
	modelEngineKey,
	modelVendor,
	piModelId,
} from "./model-engine";

describe("modelEngine", () => {
	it("reads the routing prefix", () => {
		expect(modelEngine("pi/anthropic/claude-opus-5")).toBe("pi");
		expect(modelEngine("claude/anthropic/claude-opus-5")).toBe("claude");
		expect(modelEngine("codex/openai/gpt-5.6-sol")).toBe("codex");
	});

	it("treats an unprefixed id as opencode", () => {
		expect(modelEngine("opencode/anthropic/claude-opus-5")).toBe("opencode");
		expect(modelEngine("dial/opus-fable")).toBe("opencode");
		expect(modelEngine("workspace-preset/ws-1/opus-fable")).toBe("opencode");
		// Legacy native slugs are bare model names, not engine ids.
		expect(modelEngine("claude-opus-5")).toBe("opencode");
		expect(modelEngine("")).toBe("opencode");
	});
});

describe("baseModelId", () => {
	// Byte-compatible with the pi-only version this generalizes.
	it("strips pi routing back to the picker id", () => {
		expect(baseModelId("pi/anthropic/claude-opus-5")).toBe(
			"opencode/anthropic/claude-opus-5",
		);
		expect(baseModelId("pi/dial/opus-fable")).toBe("dial/opus-fable");
		expect(baseModelId("pi/orchestrator/fable")).toBe("orchestrator/fable");
		expect(baseModelId("pi/workspace-preset/ws-1/opus-fable")).toBe(
			"workspace-preset/ws-1/opus-fable",
		);
	});

	it("strips the direct-SDK engines the same way", () => {
		expect(baseModelId("claude/anthropic/claude-opus-5")).toBe(
			"opencode/anthropic/claude-opus-5",
		);
		expect(baseModelId("codex/openai/gpt-5.6-sol")).toBe("opencode/openai/gpt-5.6-sol");
		expect(baseModelId("claude/dial/opus-fable")).toBe("dial/opus-fable");
	});

	it("passes unprefixed ids through", () => {
		expect(baseModelId("opencode/anthropic/claude-opus-5")).toBe(
			"opencode/anthropic/claude-opus-5",
		);
		expect(baseModelId("dial/opus-fable")).toBe("dial/opus-fable");
		expect(baseModelId("claude-opus-5")).toBe("claude-opus-5");
	});
});

describe("engineModelId", () => {
	it("composes pi exactly as before", () => {
		expect(piModelId("opencode/anthropic/claude-opus-5")).toBe(
			"pi/anthropic/claude-opus-5",
		);
		expect(piModelId("dial/opus-fable")).toBe("pi/dial/opus-fable");
		expect(piModelId("orchestrator/fable")).toBe("pi/orchestrator/fable");
		expect(piModelId("workspace-preset/ws-1/opus-fable")).toBe(
			"pi/workspace-preset/ws-1/opus-fable",
		);
		expect(piModelId("pi/anthropic/claude-opus-5")).toBe("pi/anthropic/claude-opus-5");
		expect(piModelId("claude-opus-5")).toBeNull();
	});

	it("composes the direct-SDK engines", () => {
		expect(engineModelId("claude", "opencode/anthropic/claude-opus-5")).toBe(
			"claude/anthropic/claude-opus-5",
		);
		expect(engineModelId("codex", "opencode/openai/gpt-5.6-sol")).toBe(
			"codex/openai/gpt-5.6-sol",
		);
	});

	it("returns the bare picker id for opencode", () => {
		expect(engineModelId("opencode", "pi/anthropic/claude-opus-5")).toBe(
			"opencode/anthropic/claude-opus-5",
		);
		expect(engineModelId("opencode", "claude/dial/opus-fable")).toBe("dial/opus-fable");
		// Legacy native ids stay selectable on opencode; only prefixing fails.
		expect(engineModelId("opencode", "claude-opus-5")).toBe("claude-opus-5");
	});

	it("re-routes an id already on another engine", () => {
		expect(engineModelId("claude", "pi/anthropic/claude-opus-5")).toBe(
			"claude/anthropic/claude-opus-5",
		);
		expect(engineModelId("pi", "codex/openai/gpt-5.6-sol")).toBe(
			"pi/openai/gpt-5.6-sol",
		);
	});

	it("refuses a vendor the direct engine does not serve", () => {
		expect(engineModelId("claude", "opencode/openai/gpt-5.6-sol")).toBeNull();
		expect(engineModelId("codex", "opencode/anthropic/claude-opus-5")).toBeNull();
		expect(engineModelId("claude", "opencode/xai/grok-5")).toBeNull();
		expect(engineModelId("codex", "opencode/xai/grok-5")).toBeNull();
	});

	it("leaves vendorless presets routable", () => {
		expect(engineModelId("claude", "dial/opus-fable")).toBe("claude/dial/opus-fable");
		expect(engineModelId("codex", "workspace-preset/ws-1/sol")).toBe(
			"codex/workspace-preset/ws-1/sol",
		);
	});

	it("refuses legacy native ids on every prefix engine", () => {
		for (const engine of ["pi", "claude", "codex"] as const) {
			expect(engineModelId(engine, "claude-opus-5")).toBeNull();
			expect(engineModelId(engine, "gpt-5.5")).toBeNull();
		}
	});
});

describe("modelVendor", () => {
	it("names the upstream provider segment", () => {
		expect(modelVendor("opencode/anthropic/claude-opus-5")).toBe("anthropic");
		expect(modelVendor("pi/openai/gpt-5.6-sol")).toBe("openai");
		expect(modelVendor("claude/anthropic/claude-opus-5")).toBe("anthropic");
	});

	it("is null where no single upstream is named", () => {
		expect(modelVendor("dial/opus-fable")).toBeNull();
		expect(modelVendor("workspace-preset/ws-1/opus-fable")).toBeNull();
		expect(modelVendor("claude-opus-5")).toBeNull();
	});
});

describe("isAnthropicModel", () => {
	it("answers from the vendor segment when the id has one", () => {
		expect(isAnthropicModel("opencode/anthropic/claude-opus-5")).toBe(true);
		expect(isAnthropicModel("pi/anthropic/claude-opus-5")).toBe(true);
		expect(isAnthropicModel("opencode/openai/gpt-5.6-sol")).toBe(false);
		// The segment wins over a stale/mismatched catalog pool.
		expect(isAnthropicModel("opencode/openai/gpt-5.6-sol", "claude")).toBe(false);
	});

	it("falls back to the catalog's account pool for presets and native slugs", () => {
		expect(isAnthropicModel("dial/opus-fable", "claude")).toBe(true);
		expect(isAnthropicModel("claude-opus-5", "claude")).toBe(true);
		expect(isAnthropicModel("dial/sol-workers", "codex")).toBe(false);
		expect(isAnthropicModel("workspace-preset/ws-1/opus-fable")).toBe(false);
	});
});

describe("modelEngineKey", () => {
	it("keys a model by its bare slug", () => {
		expect(modelEngineKey("opencode/anthropic/claude-opus-5")).toBe("claude-opus-5");
		expect(modelEngineKey("pi/openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(modelEngineKey("claude/anthropic/claude-opus-5")).toBe("claude-opus-5");
	});

	it("keeps a preset id whole", () => {
		expect(modelEngineKey("dial/opus-fable")).toBe("dial/opus-fable");
		expect(modelEngineKey("pi/workspace-preset/ws-1/opus-fable")).toBe(
			"workspace-preset/ws-1/opus-fable",
		);
		expect(modelEngineKey("claude-opus-5")).toBe("claude-opus-5");
	});

	it("never returns an engine-prefixed key", () => {
		for (const id of [
			"opencode/anthropic/claude-opus-5",
			"pi/dial/opus-fable",
			"claude/anthropic/claude-opus-5",
			"codex/openai/gpt-5.6-sol",
		]) {
			expect(modelEngineKey(id)).not.toMatch(/^(?:opencode|pi|claude|codex)\//);
		}
	});
});
