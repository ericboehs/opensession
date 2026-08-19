import { describe, expect, it, afterEach } from "bun:test";
import { editorName } from "./frontend-build";
import { __setIdentitiesForTest } from "./shared/user-mappings";

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

function roster() {
	restore = __setIdentitiesForTest([
		{ name: "Kent de Bruin", email: "kent@example.test", slackId: "U08S8B3P83X", github: "kentdebruin" },
		{ name: "Michiel Westerbeek", email: "michiel@example.test", aliases: ["michiel"] },
	]);
}

describe("editorName", () => {
	it("resolves a Slack run's raw user id to the person's name", () => {
		roster();
		expect(editorName("U08S8B3P83X")).toBe("Kent");
	});

	it("keeps a web run's display name", () => {
		roster();
		expect(editorName("Michiel")).toBe("Michiel");
	});

	it("names one person once, whichever id each of their runs carries", () => {
		roster();
		expect(editorName("kentdebruin")).toBe(editorName("U08S8B3P83X"));
	});

	it("drops a Slack id that resolves to nobody, rather than printing it", () => {
		roster();
		expect(editorName("U0NOTONROSTER")).toBeNull();
	});

	it("keeps a label that was never an id, like an agent loop", () => {
		roster();
		expect(editorName("Michael (loops)")).toBe("Michael (loops)");
	});

	it("has nothing to say about an empty user", () => {
		expect(editorName("")).toBeNull();
		expect(editorName(null)).toBeNull();
	});
});
