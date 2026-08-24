import { describe, expect, test } from "bun:test";
import {
	SIDE_PANEL_OPEN_KEY,
	sidePanelOpen,
	storeSidePanelOpen,
} from "./side-panel-open";

function memoryStorage(initial?: string) {
	const values = new Map<string, string>();
	if (initial !== undefined) values.set(SIDE_PANEL_OPEN_KEY, initial);
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("workspace side panel preference", () => {
	test("defaults to the summary card", () => {
		expect(sidePanelOpen(memoryStorage())).toBe(false);
	});

	test("remembers an explicitly opened or closed panel", () => {
		const storage = memoryStorage();
		storeSidePanelOpen(true, storage);
		expect(sidePanelOpen(storage)).toBe(true);
		storeSidePanelOpen(false, storage);
		expect(sidePanelOpen(storage)).toBe(false);
	});
});
