import { describe, expect, test } from "bun:test";
import type { UnifiedSession } from "./types";
import { sessionPrApproved, sessionPrMerged } from "./session-prs";

function session(overrides: Partial<UnifiedSession>): UnifiedSession {
	return {
		id: "bks-test",
		claudeSessionId: null,
		source: "backstage",
		branch: "feature",
		worktreeDir: "/tmp/feature",
		startedBy: "test",
		title: "Test",
		lastActivity: "2026-07-28T00:00:00Z",
		createdAt: "2026-07-28T00:00:00Z",
		isRunning: false,
		transcriptPath: null,
		...overrides,
	};
}

describe("session PR lifecycle", () => {
	test("ignores attached branches that have no pull request", () => {
		const value = session({
			prState: "MERGED",
			prs: [
				{
					repo: "tella-fusion",
					branch: "feature",
					source: "primary",
					number: 5016,
					state: "MERGED",
				},
				{
					repo: "shared-infra",
					branch: "infra-feature",
					source: "attached",
				},
			],
		});

		expect(sessionPrMerged(value)).toBe(true);
		expect(sessionPrApproved(value)).toBe(true);
	});

	test("keeps a multi-PR session unfinished while an actual PR is open", () => {
		const value = session({
			prs: [
				{
					repo: "tella-fusion",
					branch: "feature",
					source: "primary",
					number: 1,
					state: "MERGED",
				},
				{
					repo: "shared-infra",
					branch: "infra-feature",
					source: "attached",
					number: 2,
					state: "OPEN",
				},
			],
		});

		expect(sessionPrMerged(value)).toBe(false);
		expect(sessionPrApproved(value)).toBe(false);
	});

	test("keeps a known PR with unknown state unfinished", () => {
		const value = session({
			prState: "MERGED",
			prs: [
				{
					repo: "tella-fusion",
					branch: "feature",
					source: "primary",
					number: 1,
					state: "MERGED",
				},
				{
					repo: "shared-infra",
					branch: "infra-feature",
					source: "linked",
					number: 2,
				},
			],
		});

		expect(sessionPrMerged(value)).toBe(false);
		expect(sessionPrApproved(value)).toBe(false);
	});

	test("keeps a bare explicit PR link unfinished", () => {
		const value = session({
			prState: "MERGED",
			prs: [
				{
					repo: "tella-fusion",
					branch: "feature",
					source: "primary",
					number: 1,
					state: "MERGED",
				},
				{
					repo: "shared-infra",
					branch: "infra-feature",
					source: "linked",
				},
			],
		});

		expect(sessionPrMerged(value)).toBe(false);
		expect(sessionPrApproved(value)).toBe(false);
	});
});
