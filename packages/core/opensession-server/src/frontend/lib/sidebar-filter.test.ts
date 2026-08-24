import { beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key),
};

const { rememberRepoCount } = await import("./repo-count");
const {
	FILTER_KEY,
	FILTER_VERSION,
	defaultByProject,
	defaultGroupBy,
	readStoredFilter,
} = await import("./sidebar-filter");

function write(blob: Record<string, unknown>) {
	store.set(FILTER_KEY, JSON.stringify(blob));
}

beforeEach(() => store.clear());

describe("the default grouping", () => {
	test("inbox is the section mode regardless of project count", () => {
		rememberRepoCount(1);
		expect(defaultGroupBy()).toBe("inbox");
		rememberRepoCount(4);
		expect(defaultGroupBy()).toBe("inbox");
	});

	test("project grouping is the independent count-sensitive default", () => {
		rememberRepoCount(1);
		expect(defaultByProject()).toBeFalse();
		rememberRepoCount(4);
		expect(defaultByProject()).toBeTrue();
	});
});

describe("readStoredFilter", () => {
	test("nothing stored leaves grouping automatic and hides optional rows", () => {
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		expect(stored.byProject).toBe("auto");
		expect(stored.prs).toBe("none");
		expect(stored.autoCreated).toBe("hide");
	});

	test.each(["inbox", "activity", "status"] as const)(
		"a %s pick at the current version is honoured",
		(groupBy) => {
			write({ v: FILTER_VERSION, groupBy, byProject: true });
			const stored = readStoredFilter();
			expect(stored.groupBy).toBe(groupBy);
			expect(stored.byProject).toBeTrue();
		},
	);

	test("unknown current values read as unpicked", () => {
		write({ v: FILTER_VERSION, groupBy: "sideways", byProject: "maybe" });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		expect(stored.byProject).toBe("auto");
	});

	test.each([
		["settled", "inbox", false],
		["activity", "activity", true],
		["status", "status", false],
	] as const)("v7 %s migrates across both axes", (old, groupBy, byProject) => {
		write({ v: 7, groupBy: old, byProject });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe(groupBy);
		expect(stored.byProject).toBe(byProject);
	});

	test.each([
		["none", "inbox", false],
		["repo", "inbox", true],
		["status", "status", false],
		["auto", "auto", "auto"],
	] as const)("v6 %s keeps its meaning across both axes", (old, groupBy, byProject) => {
		write({ v: 6, groupBy: old });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe(groupBy);
		expect(stored.byProject).toBe(byProject);
	});

	test.each([4, 5] as const)("v%s restores the old two-axis pair", (version) => {
		write({ v: version, sections: "inbox", groupBy: "repo" });
		let stored = readStoredFilter();
		expect(stored.groupBy).toBe("activity");
		expect(stored.byProject).toBeTrue();

		write({ v: version, sections: "status", groupBy: "none" });
		stored = readStoredFilter();
		expect(stored.groupBy).toBe("status");
		expect(stored.byProject).toBeFalse();
	});

	test("the pre-rename lanes key is still read", () => {
		write({ v: 4, lanes: "status", groupBy: "repo" });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe("status");
		expect(stored.byProject).toBeTrue();
	});

	test.each([
		["repo-inbox", "activity", true],
		["repo-status", "status", true],
		["repo", "activity", true],
		["inbox", "activity", false],
		["status", "status", false],
	] as const)("v3 %s keeps both meanings", (old, groupBy, byProject) => {
		write({ v: 3, groupBy: old });
		const stored = readStoredFilter();
		expect(stored.groupBy).toBe(groupBy);
		expect(stored.byProject).toBe(byProject);
	});

	test("ambiguous old defaults remain unpicked", () => {
		write({ v: 2, groupBy: "repo-status", repo: "acme", person: "kent" });
		let stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		expect(stored.byProject).toBe("auto");
		expect(stored.repo).toBe("acme");
		expect(stored.person).toBe("kent");

		write({ groupBy: "status" });
		stored = readStoredFilter();
		expect(stored.groupBy).toBe("auto");
		expect(stored.byProject).toBe("auto");
	});

	test.each(["default", "all", "none"] as const)(
		"an explicit %s pull request choice is preserved",
		(prs) => {
			write({ v: FILTER_VERSION, prs });
			expect(readStoredFilter().prs).toBe(prs);
		},
	);

	test("an absent or unknown pull request choice defaults to hidden", () => {
		write({ v: FILTER_VERSION });
		expect(readStoredFilter().prs).toBe("none");
		write({ v: FILTER_VERSION, prs: "surprise" });
		expect(readStoredFilter().prs).toBe("none");
	});

	test("agent-created work is shown from the version that made it a choice", () => {
		write({ v: 4, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("hide");
		write({ v: 5, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("show");
		write({ v: FILTER_VERSION, autoCreated: "show" });
		expect(readStoredFilter().autoCreated).toBe("show");
	});

	test("empty projects show unless they were hidden", () => {
		expect(readStoredFilter().emptyProjects).toBe("show");
		write({ v: FILTER_VERSION, emptyProjects: "hide" });
		expect(readStoredFilter().emptyProjects).toBe("hide");
	});
});
