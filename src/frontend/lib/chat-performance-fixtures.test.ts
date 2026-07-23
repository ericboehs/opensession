import { describe, expect, test } from "bun:test";
import { makeChatFixture, makeStreamDeltas } from "./chat-performance-fixtures";

describe("chat performance fixtures", () => {
	for (const size of [200, 2_000, 10_000] as const) {
		test(`builds a stable ${size}-entry fixture`, () => {
			const entries = makeChatFixture(size);
			expect(entries).toHaveLength(size);
			expect(entries[0].id).toBe("fixture-00000");
			expect(entries.at(-1)?.id).toBe(
				`fixture-${String(size - 1).padStart(5, "0")}`,
			);
		});
	}

	test("models 100 deltas per second", () => {
		const deltas = makeStreamDeltas(100, 2);
		expect(deltas).toHaveLength(200);
		expect(deltas[100].atMs).toBe(1_000);
	});
});
