import { describe, expect, test } from "bun:test";
import { makeUserMap } from "./user-map";

// A store with the server side driven by hand. There is no DOM under the test
// runner, so nothing auto-hydrates and no retry timer is armed: every
// hydration below is the one the test asked for.
function harness(user = "ann") {
	const saves: { user: string; map: Record<string, string> }[] = [];
	let respond: (map: Record<string, string>) => void = () => {};
	let fail: () => void = () => {};
	let mode: "fail" | "deferred" | Record<string, string> = {};
	const store = makeUserMap<string>({
		changeEvent: "test-map-changed",
		fetchMap: () => {
			if (mode === "fail") return Promise.reject(new Error("502"));
			if (mode === "deferred")
				return new Promise<Record<string, string>>((resolve, reject) => {
					respond = resolve;
					fail = () => reject(new Error("502"));
				});
			return Promise.resolve({ ...mode });
		},
		saveMap: async (u, map) => {
			saves.push({ user: u, map });
			return map;
		},
		currentUser: () => user,
	});
	return {
		store,
		saves,
		serves: (map: Record<string, string>) => {
			mode = map;
		},
		failsFetch: () => {
			mode = "fail";
		},
		defers: () => {
			mode = "deferred";
		},
		respond: (map: Record<string, string>) => respond(map),
		fail: () => fail(),
		switchTo: (next: string) => {
			user = next;
		},
	};
}

describe("makeUserMap", () => {
	test("a failed hydration keeps the cache and does not mark the store ready", async () => {
		const h = harness();
		h.serves({ a: "1" });
		await h.store.hydrate();
		expect(h.store.get()).toEqual({ a: "1" });
		expect(h.store.ready()).toBe(true);

		h.failsFetch();
		await h.store.hydrate();
		// The empty response the fetch never gave us must not land in the cache.
		expect(h.store.get()).toEqual({ a: "1" });
		expect(h.saves).toEqual([]);
	});

	test("nothing is committed or PUT when the first hydration fails", async () => {
		const h = harness();
		h.failsFetch();
		await h.store.hydrate();
		expect(h.store.ready()).toBe(false);
		expect(h.store.get()).toEqual({});

		// The write that used to erase the server map: it is held as an intent.
		h.store.update((map) => ({ ...map, hidden: "now" }));
		await Promise.resolve();
		expect(h.saves).toEqual([]);
		expect(h.store.get()).toEqual({ hidden: "now" });

		// Once the server answers, the intent lands on top of its map and only
		// that merge is persisted.
		h.serves({ other: "kept", gone: "kept" });
		await h.store.hydrate();
		expect(h.store.get()).toEqual({
			other: "kept",
			gone: "kept",
			hidden: "now",
		});
		expect(h.saves).toEqual([
			{ user: "ann", map: { other: "kept", gone: "kept", hidden: "now" } },
		]);
	});

	test("a delete made before hydration is applied to the server map", async () => {
		const h = harness();
		h.failsFetch();
		await h.store.hydrate();
		h.store.update((map) => ({ ...map, a: "local" }));
		h.store.update((map) => {
			const next = { ...map };
			delete next.a;
			return next;
		});
		h.serves({ a: "server", b: "server" });
		await h.store.hydrate();
		expect(h.store.get()).toEqual({ b: "server" });
	});

	test("a write during an in-flight hydration survives it", async () => {
		const h = harness();
		h.defers();
		const inFlight = h.store.hydrate();
		h.store.update((map) => ({ ...map, mine: "fresh" }));
		h.respond({ mine: "stale", other: "server" });
		await inFlight;
		expect(h.store.get()).toEqual({ mine: "fresh", other: "server" });
		expect(h.store.ready()).toBe(true);
	});

	test("a user switch mid-flight discards the stale response", async () => {
		const h = harness("ann");
		h.defers();
		const inFlight = h.store.hydrate("ann");
		h.switchTo("bo");
		h.respond({ ann: "only" });
		await inFlight;
		expect(h.store.get()).toEqual({});
		expect(h.store.ready()).toBe(false);
		expect(h.saves).toEqual([]);
	});

	test("a hydration superseded by a newer one is discarded", async () => {
		const h = harness();
		h.defers();
		const first = h.store.hydrate();
		const stale = h.respond;
		h.serves({ newer: "1" });
		await h.store.hydrate();
		stale({ older: "1" });
		await first;
		expect(h.store.get()).toEqual({ newer: "1" });
	});

	test("a write after hydration PUTs the whole map", async () => {
		const h = harness();
		h.serves({ a: "1" });
		await h.store.hydrate();
		h.store.update((map) => ({ ...map, b: "2" }));
		expect(h.saves).toEqual([{ user: "ann", map: { a: "1", b: "2" } }]);
	});

	test("a mutator returning null changes nothing", async () => {
		const h = harness();
		h.serves({ a: "1" });
		await h.store.hydrate();
		expect(h.store.update(() => null)).toEqual({ a: "1" });
		expect(h.saves).toEqual([]);
	});
});
