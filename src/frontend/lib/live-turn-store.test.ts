import { describe, expect, test } from "bun:test";
import { LiveTurnStore } from "./live-turn-store";

describe("LiveTurnStore", () => {
	test("coalesces a burst of deltas into one published text snapshot", async () => {
		const store = new LiveTurnStore();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => notifications++);
		store.start("Jaap", "run-1");
		for (let index = 0; index < 100; index++) store.append(String(index % 10));
		await Bun.sleep(25);
		expect(store.getSnapshot().text).toHaveLength(100);
		// start + a single frame flush (the 130ms markdown-settle tick is later).
		expect(notifications).toBe(2);
		unsubscribe();
		store.clear();
	});

	test("deduplicates committed text in either arrival order", async () => {
		const store = new LiveTurnStore();
		store.start(undefined, "run-2");
		store.land(["already committed"]);
		store.append("already committed");
		await Bun.sleep(25);
		expect(store.getSnapshot().text).toBe("");

		store.append("streamed first");
		await Bun.sleep(25);
		store.land(["streamed first"]);
		expect(store.getSnapshot().text).toBe("");
		store.clear();
	});
});
