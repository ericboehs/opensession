import { describe, expect, test } from "bun:test";
import type { PrDetails } from "../../server/pr-info";
import { buildAutoFixPrompt, buildReviewPrompt, mergeabilityState } from "./prompts";

function pr(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    number: 42,
    title: "Test PR",
    url: "https://github.com/tellahq/tella-fusion/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix/test",
    headRefOid: "abc123",
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
  test("classifies clear, conflicting, stale, and unknown states", () => {
    expect(mergeabilityState(pr(), "abc123")).toBe("clear");
    expect(mergeabilityState(pr({ mergeable: "CONFLICTING" }), "abc123")).toBe("conflicting");
    expect(mergeabilityState(pr({ mergeStateStatus: "DIRTY" }), "abc123")).toBe("conflicting");
    expect(mergeabilityState(pr({ mergeable: "UNKNOWN" }), "abc123")).toBe("pending");
    expect(mergeabilityState(pr(), "new-head")).toBe("pending");
    expect(mergeabilityState(null, "abc123")).toBe("pending");
  });

  test("requires a non-force-pushed base merge when conflicts exist", () => {
    const prompt = buildAutoFixPrompt(pr({ mergeable: "CONFLICTING" }), "", [], 1);

    expect(prompt).toContain("conflicts with `main`");
    expect(prompt).toContain("merge it into the current branch without rebasing");
    expect(prompt).toContain("Never force-push");
  });

  test("does not tell the fixer that pending mergeability is conflict-free", () => {
    const prompt = buildAutoFixPrompt(pr({ mergeable: "UNKNOWN" }), "", [], 1);

    expect(prompt).toContain("still calculating");
    expect(prompt).toContain("do not assume the branch is conflict-free");
  });
});

describe("review diff context", () => {
  test("reads the complete diff from the pinned worktree instead of inlining it", () => {
    const prompt = buildReviewPrompt("Review carefully.", pr(), false);

    expect(prompt).toContain("git diff --find-renames origin/main...HEAD");
    expect(prompt).not.toContain("===BEGIN PR DIFF===");
  });
});
