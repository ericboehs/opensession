import { describe, expect, test } from "bun:test";
import { resolveSessionRepoContext } from "./session-repos";

const session = {
	repo: "backstage",
	worktreeDir: "/home/ubuntu/projects/tella-backstage",
	branch: "master",
	attachedRepos: [
		{
			repo: "tella-fusion",
			dir: "/home/ubuntu/worktrees/tella-fusion-task",
			branch: "task",
		},
		{
			repo: "infra",
			dir: "/home/ubuntu/worktrees/infra-task",
			branch: "task",
		},
	],
};

describe("resolveSessionRepoContext", () => {
	test("defaults to the primary repo", () => {
		expect(resolveSessionRepoContext(session)?.repo).toBe("backstage");
	});

	test("selects an attached repo explicitly", () => {
		expect(resolveSessionRepoContext(session, "tella-fusion")).toEqual({
			repo: "tella-fusion",
			dir: "/home/ubuntu/worktrees/tella-fusion-task",
			branch: "task",
			primary: false,
		});
	});

	test("infers exactly one attached worktree from a delegated prompt", () => {
		const resolved = resolveSessionRepoContext(
			session,
			undefined,
			"Review the changes in /home/ubuntu/worktrees/tella-fusion-task and report findings.",
		);
		expect(resolved?.repo).toBe("tella-fusion");
	});

	test("keeps the primary when a prompt is ambiguous", () => {
		const resolved = resolveSessionRepoContext(
			session,
			undefined,
			"Compare /home/ubuntu/worktrees/tella-fusion-task with /home/ubuntu/worktrees/infra-task.",
		);
		expect(resolved?.repo).toBe("backstage");
	});

	test("rejects an explicit repo the parent does not carry", () => {
		expect(resolveSessionRepoContext(session, "gitops")).toBeNull();
	});
});
