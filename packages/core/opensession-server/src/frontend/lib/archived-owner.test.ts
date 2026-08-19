import { describe, expect, test } from "bun:test";
import { archivedOwners, canonicalNames, ownerKeyOf, sessionHasOwner } from "./archived-owner";
import type { Person } from "./people";
import type { UnifiedSession } from "./types";

const roster: Person[] = [
	{ name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
	{ name: "Michiel", fullName: "Michiel Westerbeek", github: "happylinks" },
];
const canonical = canonicalNames(roster);

function session(p: Partial<UnifiedSession>): UnifiedSession {
	return { id: "s", title: "t", archived: true, lastActivity: "", ...p } as UnifiedSession;
}

describe("archived owner lens", () => {
	test("merges a person's first-name and full-name spellings", () => {
		expect(ownerKeyOf(session({ startedBy: "Michiel Westerbeek" }), canonical)).toBe("michiel");
		expect(ownerKeyOf(session({ startedBy: "michiel" }), canonical)).toBe("michiel");
	});

	test("falls back to the raw name when the directory is empty", () => {
		expect(ownerKeyOf(session({ startedBy: "Kent" }), new Map())).toBe("kent");
	});

	test("offers only directory people, most-archived first, without me", () => {
		const owners = archivedOwners(
			[
				session({ startedBy: "Michiel Westerbeek" }),
				session({ startedBy: "Michiel" }),
				session({ startedBy: "Kent" }),
				// Not teammates: a spawned worker, the agent persona, an automation.
				session({ startedBy: "worker os-019fe194-5fbe-7000-a81e-d0a656ad77f4" }),
				session({ startedBy: "Michael" }),
				session({ startedBy: "Kent", automation: "nightly" }),
			],
			canonical,
			"kent",
		);
		expect(owners).toEqual([{ key: "michiel", label: "Michiel" }]);
	});

	test("a person's rows exclude automations they started", () => {
		expect(sessionHasOwner(session({ startedBy: "Kent" }), "kent", canonical)).toBe(true);
		expect(
			sessionHasOwner(session({ startedBy: "Kent", automation: "nightly" }), "kent", canonical),
		).toBe(false);
		expect(sessionHasOwner(session({}), "kent", canonical)).toBe(false);
	});
});
