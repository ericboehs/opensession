import { describe, expect, test } from "bun:test";
import type { PrDetails } from "../../server/pr-info";
import { buildAutoFixPrompt, isMergeConflicting } from "./prompts";

function pr(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 42,
    title: "Test PR",
    url: "https://github.com/tellahq/tella-fusion/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix/test",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: "",
    author: "author",
    body: "",
    checks: [],
    comments: [],
    files: [],
    reviewers: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    staging: null,
    ...overrides,
  };
}

describe("auto-fix merge conflicts", () => {
  test("recognizes both GitHub conflict signals", () => {
    expect(isMergeConflicting(pr({ mergeable: "CONFLICTING" }))).toBe(true);
    expect(isMergeConflicting(pr({ mergeStateStatus: "DIRTY" }))).toBe(true);
    expect(isMergeConflicting(pr())).toBe(false);
  });

  test("requires a non-force-pushed base merge when conflicts exist", () => {
    const prompt = buildAutoFixPrompt(pr({ mergeable: "CONFLICTING" }), "", [], 1);

    expect(prompt).toContain("conflicts with `main`");
    expect(prompt).toContain("merge it into the current branch without rebasing");
    expect(prompt).toContain("Never force-push");
  });
});
