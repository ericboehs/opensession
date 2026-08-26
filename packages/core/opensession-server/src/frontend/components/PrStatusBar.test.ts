import { expect, test } from "bun:test";
import type { GitStatusInfo } from "../lib/types";
import { deriveHeadline } from "../lib/pr-headline";

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
	return {
		branch: "main",
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		behindBase: 0,
		baseBranch: "main",
		uncommittedFiles: 0,
		sharedCheckout: false,
		...overrides,
	};
}

test("does not offer Pull or Push for a shared checkout's instance-wide divergence", () => {
	expect(
		deriveHeadline(
			null,
			gitStatus({ sharedCheckout: true, ahead: 71, behind: 187 }),
		),
	).toEqual({ key: "clean", label: "Up to date", tone: "muted" });
});

test("says the PR status is unavailable rather than claiming there is no PR", () => {
	// A failed PR read arrives as a null pr, exactly like a branch with no PR.
	// Claiming "No PR open" there offers Create PR on a branch that may already
	// have one, and nothing about it ever corrects itself.
	expect(
		deriveHeadline(null, gitStatus({ branch: "feature", ahead: 2 }), true),
	).toEqual({
		key: "unavailable",
		label: "PR status unavailable",
		tone: "yellow",
	});
});

test("a successful read with no PR still says No PR open", () => {
	expect(
		deriveHeadline(null, gitStatus({ branch: "feature", ahead: 2 }), false).key,
	).toBe("no-pr");
});

test("keeps Pull for an isolated worktree behind its own upstream", () => {
	expect(deriveHeadline(null, gitStatus({ behind: 2 }))).toEqual({
		key: "behind",
		label: "Behind by 2 commits",
		tone: "yellow",
	});
});
