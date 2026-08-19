import { beforeEach, describe, expect, test } from "bun:test";

// The module reads localStorage lazily, inside its functions — but bun has no
// localStorage, so stand one up before importing it.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

const { rememberRepoCount } = await import("./repo-count");
const { FILTER_KEY, FILTER_VERSION, defaultGroupBy, readStoredFilter } =
	await import("./sidebar-filter");

function write(blob: Record<string, unknown>) {
	store.set(FILTER_KEY, JSON.stringify(blob));
}

beforeEach(() => store.clear());

describe("the default grouping", () => {
	test("one project has nothing to band by", () => {
		rememberRepoCount(1);
		expect(defaultGroupBy()).toBe("none");
	});

	test("several projects get one band each", () => {
		rememberRepoCount(4);
		expect(defaultGroupBy()).toBe("repo");
	});

	// An instance with no project registered yet has nothing to group by
	// either — it is the empty end of the same case.
	test("no projects has nothing to band by", () => {
		rememberRepoCount(0);
		expect(defaultGroupBy()).toBe("none");
	});
});

describe("readStoredFilter", () => {
	test("nothing stored leaves the grouping to the default", () => {
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		expect(stored.autoCreated).toBe("hide");
	});

	test.each(["none", "repo", "status"] as const)(
		"a %s pick at the current version is honoured",
		(groupBy) => {
			write({ v: FILTER_VERSION, groupBy });
			expect(readStoredFilter().groupBy).toBe(groupBy);
		},
	);

	test("an explicit auto stays auto", () => {
		write({ v: FILTER_VERSION, groupBy: "auto" });
		expect(readStoredFilter().groupBy).toBe("auto");
	});

	test("a grouping nobody recognises reads as unset", () => {
		write({ v: FILTER_VERSION, groupBy: "sideways" });
		expect(readStoredFilter().groupBy).toBe("auto");
	});

	// v4 and v5 stored the sections/banding pair. Asking for the status lanes
	// is a pick that survives whatever it was banded by, since the lanes are
	// the half being kept and only the nesting went away.
	test.each([4, 5] as const)(
		"v%s status lanes survive whether or not they were banded by project",
		(v) => {
			write({ v, sections: "status", groupBy: "repo" });
			expect(readStoredFilter().groupBy).toBe("status");

			write({ v, sections: "status", groupBy: "none" });
			expect(readStoredFilter().groupBy).toBe("status");
		},
	);

	test("a section-less list falls back to its project banding", () => {
		write({ v: 5, sections: "none", groupBy: "repo" });
		expect(readStoredFilter().groupBy).toBe("repo");

		write({ v: 5, sections: "none", groupBy: "none" });
		expect(readStoredFilter().groupBy).toBe("none");
	});

	test("an inbox banded by project keeps its bands", () => {
		write({ v: 5, sections: "inbox", groupBy: "repo" });
		expect(readStoredFilter().groupBy).toBe("repo");
	});

	test("a pair with neither axis picked is still unset", () => {
		write({ v: 5, sections: "auto", groupBy: "auto" });
		expect(readStoredFilter().groupBy).toBe("auto");
	});

	// The sections axis shipped as `lanes` before it was renamed, inside v4.
	// Same values, so a blob written in between still says what it means.
	test("the pre-rename key is still read", () => {
		write({ v: 4, lanes: "status", groupBy: "repo" });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("status");
		expect(stored.autoCreated).toBe("hide");
	});

	// v3 stored one compound grouping, and stored "auto" when nobody picked —
	// so what it names is a real choice. "repo-status" lands on the lanes.
	test.each([
		["repo-inbox", "repo"],
		["repo-status", "status"],
		["repo", "repo"],
		["inbox", "none"],
		["status", "status"],
	] as const)("v3 %s reads as %s", (groupBy, expected) => {
		write({ v: 3, groupBy });
		expect(readStoredFilter().groupBy).toBe(expected);
	});

	// "recently" was never in the menu, and the sidebar drew it as the plain
	// status lanes — nothing it can map to that anyone asked for.
	test("a v3 grouping that was never offered reads as unset", () => {
		write({ v: 3, groupBy: "recently" });
		expect(readStoredFilter().groupBy).toBe("auto");
	});

	// Before v3 the whole state persisted together, so "repo-status" on a v2
	// blob is as likely to be that version's default as anyone's choice.
	test("the previous version's default reads as unset", () => {
		write({ v: 2, groupBy: "repo-status", repo: "acme", person: "kent" });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		// Everything the person did choose survives the migration.
		expect(stored.repo).toBe("acme");
		expect(stored.person).toBe("kent");
	});

	test("a v2 pick that was never a default survives", () => {
		write({ v: 2, groupBy: "status" });
		expect(readStoredFilter().groupBy).toBe("status");
	});

	// "status" was the default before v2, so a blob older than that says
	// nothing about what its owner wanted.
	test("a pre-v2 status reads as unset", () => {
		write({ groupBy: "status" });
		expect(readStoredFilter().groupBy).toBe("auto");
	});

	// v4's "show" was that version's default rather than a choice; v5 is where
	// it became one, so it and every version after it are taken at their word.
	test("agent-created work is shown from the version that made it a choice", () => {
		write({ v: 4, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("hide");

		write({ v: 5, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("show");

		write({ v: FILTER_VERSION, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("show");
	});

	// Empty project bands are the long-standing behaviour, so a blob that
	// never heard of the setting keeps them.
	test("empty projects show unless they were hidden", () => {
		expect(readStoredFilter().emptyProjects).toBe("show");
		write({ v: FILTER_VERSION, emptyProjects: "hide" });
		expect(readStoredFilter().emptyProjects).toBe("hide");
	});
});
