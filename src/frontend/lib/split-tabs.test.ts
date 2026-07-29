import { beforeEach, describe, expect, test } from "bun:test";
import {
	clampSplitRatio,
	clearTabSplit,
	getTabSplit,
	saveTabSplit,
	splitIsLive,
} from "./split-tabs";

class StorageStub {
	private values = new Map<string, string>();
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	clear() {
		this.values.clear();
	}
}

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: new StorageStub(),
		configurable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: {
			dispatchEvent() {},
			addEventListener() {},
			removeEventListener() {},
		},
		configurable: true,
	});
});

describe("split tabs", () => {
	test("persists a clamped split per workspace", () => {
		saveTabSplit("workspace", { leftId: "a", rightId: "b", ratio: 0.95 });
		expect(getTabSplit("workspace")).toEqual({
			leftId: "a",
			rightId: "b",
			ratio: 0.8,
		});
	});

	test("clears only the requested workspace", () => {
		saveTabSplit("one", { leftId: "a", rightId: "b", ratio: 0.5 });
		saveTabSplit("two", { leftId: "c", rightId: "d", ratio: 0.5 });
		clearTabSplit("one");
		expect(getTabSplit("one")).toBeNull();
		expect(getTabSplit("two")?.leftId).toBe("c");
	});

	test("requires both split members to remain live", () => {
		const split = { leftId: "a", rightId: "b", ratio: 0.5 };
		expect(splitIsLive(split, ["a", "b", "c"])).toBe(true);
		expect(splitIsLive(split, ["a", "c"])).toBe(false);
	});

	test("clamps divider ratios", () => {
		expect(clampSplitRatio(-1)).toBe(0.2);
		expect(clampSplitRatio(0.46)).toBe(0.46);
		expect(clampSplitRatio(2)).toBe(0.8);
	});
});
