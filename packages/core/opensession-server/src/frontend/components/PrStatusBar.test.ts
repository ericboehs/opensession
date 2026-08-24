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

test("keeps Pull for an isolated worktree behind its own upstream", () => {
	expect(deriveHeadline(null, gitStatus({ behind: 2 }))).toEqual({
		key: "behind",
		label: "Behind by 2 commits",
		tone: "yellow",
	});
});
