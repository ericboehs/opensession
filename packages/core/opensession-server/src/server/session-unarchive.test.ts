import { describe, expect, test } from "bun:test";
import {
	type HumanTurnUnarchiveDeps,
	unarchiveForHumanTurn,
} from "./session-unarchive";

function recorder(registryIds: string[] = []) {
	const archived: Array<[string, boolean]> = [];
	const files: string[] = [];
	const registry = new Set(registryIds);
	let invalidations = 0;
	const deps: HumanTurnUnarchiveDeps = {
		isArchivedId(id) {
			return registry.has(id);
		},
		setArchived(id, value) {
			archived.push([id, value]);
		},
		clearSessionFileArchive(id) {
			files.push(id);
			return true;
		},
		invalidateSessionsCache() {
			invalidations++;
		},
	};
	return { archived, files, deps, invalidations: () => invalidations };
}

describe("unarchiveForHumanTurn", () => {
	test("clears every archive identity before accepting a turn", () => {
		const calls = recorder();
		expect(
			unarchiveForHumanTurn(
				{
					id: "os-current",
					aliasIds: ["os-old", "os-current"],
					archived: true,
				},
				calls.deps,
			),
		).toBe(true);
		expect(calls.archived).toEqual([
			["os-current", false],
			["os-old", false],
		]);
		expect(calls.files).toEqual(["os-current"]);
		expect(calls.invalidations()).toBe(1);
	});

	test("catches archive registry state newer than the session cache", () => {
		const calls = recorder(["os-stale"]);
		expect(
			unarchiveForHumanTurn({ id: "os-stale", archived: false }, calls.deps),
		).toBe(true);
		expect(calls.archived).toEqual([["os-stale", false]]);
		expect(calls.files).toEqual(["os-stale"]);
		expect(calls.invalidations()).toBe(1);
	});

	test("leaves an active session untouched", () => {
		const calls = recorder();
		expect(
			unarchiveForHumanTurn({ id: "os-live", archived: false }, calls.deps),
		).toBe(false);
		expect(calls.archived).toEqual([]);
		expect(calls.files).toEqual([]);
		expect(calls.invalidations()).toBe(0);
	});
});
