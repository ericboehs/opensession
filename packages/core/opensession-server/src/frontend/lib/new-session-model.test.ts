import { describe, expect, test } from "bun:test";
import { preferredNewSessionModel } from "./new-session-model";

const models = [
	{ id: "opencode/anthropic/claude-opus-5" },
	{ id: "opencode/openai/gpt-5.6-sol" },
	{ id: "dial/opus-fable" },
];

const base = {
	models,
	default: "dial/opus-fable",
	modelPref: "",
	enginePref: "",
	availableEngines: ["opencode", "pi"],
};

describe("preferredNewSessionModel", () => {
	test("no preference at all leaves the choice to the server", () => {
		expect(preferredNewSessionModel(base)).toBe("");
	});

	test("a model preference is preselected as it is", () => {
		expect(
			preferredNewSessionModel({
				...base,
				modelPref: "opencode/anthropic/claude-opus-5",
			}),
		).toBe("opencode/anthropic/claude-opus-5");
	});

	test("a model preference the catalog no longer lists is ignored", () => {
		expect(
			preferredNewSessionModel({ ...base, modelPref: "opencode/acme/gone" }),
		).toBe("");
	});

	test("an engine preference names the catalog default so it can carry it", () => {
		expect(preferredNewSessionModel({ ...base, enginePref: "pi" })).toBe(
			"pi/dial/opus-fable",
		);
	});

	test("both preferences compose", () => {
		expect(
			preferredNewSessionModel({
				...base,
				modelPref: "opencode/anthropic/claude-opus-5",
				enginePref: "pi",
			}),
		).toBe("pi/anthropic/claude-opus-5");
	});

	test("OpenCode is the unprefixed base form, not a prefix", () => {
		expect(
			preferredNewSessionModel({
				...base,
				modelPref: "opencode/anthropic/claude-opus-5",
				enginePref: "opencode",
			}),
		).toBe("opencode/anthropic/claude-opus-5");
	});

	test("an engine that is no longer offered reads as no preference", () => {
		expect(
			preferredNewSessionModel({
				...base,
				modelPref: "opencode/anthropic/claude-opus-5",
				enginePref: "pi",
				availableEngines: ["opencode"],
			}),
		).toBe("opencode/anthropic/claude-opus-5");
	});

	test("a model that cannot route to the engine keeps the unprefixed id", () => {
		// A legacy native slug carries no prefixable shape.
		expect(
			preferredNewSessionModel({
				...base,
				default: "claude-opus-5",
				enginePref: "pi",
			}),
		).toBe("");
		expect(
			preferredNewSessionModel({
				...base,
				models: [...models, { id: "claude-opus-5" }],
				modelPref: "claude-opus-5",
				enginePref: "pi",
			}),
		).toBe("claude-opus-5");
	});

	test("a workspace preset default is retained, and takes the engine", () => {
		const wsDefault = { ...base, default: "workspace-preset/ws-1/opus-fable" };
		expect(preferredNewSessionModel(wsDefault)).toBe(
			"workspace-preset/ws-1/opus-fable",
		);
		expect(preferredNewSessionModel({ ...wsDefault, enginePref: "pi" })).toBe(
			"pi/workspace-preset/ws-1/opus-fable",
		);
	});
});
