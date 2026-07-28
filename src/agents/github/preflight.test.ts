import { afterEach, describe, expect, test } from "bun:test";
import { buildPreflightReviewPrompt, DEFAULT_REVIEW_PROMPT } from "./prompts";
import { preflightReviewerFor } from "./model-inversion";

describe("buildPreflightReviewPrompt", () => {
  const opts = {
    ghRepo: "tellahq/tella-fusion",
    branch: "fix/thing",
    baseBranch: "main",
  };

  test("carries the base prompt, branch context, and output contract", () => {
    const p = buildPreflightReviewPrompt(DEFAULT_REVIEW_PROMPT, opts);
    expect(p).toContain("Pre-flight review");
    expect(p).toContain("`fix/thing`");
    expect(p).toContain("origin/main");
    expect(p).toContain("## Output format (required)");
    // Uncommitted work is part of the prospective PR.
    expect(p).toContain("git status --short");
    // No PR yet — the diagram field and GitHub anchoring don't apply.
    expect(p).toContain("Omit the `diagram` field");
  });

  test("includes the author-family sweep and ignore globs when given", () => {
    const p = buildPreflightReviewPrompt(DEFAULT_REVIEW_PROMPT, {
      ...opts,
      authorFamily: "anthropic",
      ignoreGlobs: ["generated/**"],
    });
    expect(p).toContain("Claude-family agent");
    expect(p).toContain("generated/**");
    expect(buildPreflightReviewPrompt(DEFAULT_REVIEW_PROMPT, opts)).not.toContain(
      "Author-specific sweep",
    );
  });

  test("threads the focus steer", () => {
    const p = buildPreflightReviewPrompt(DEFAULT_REVIEW_PROMPT, {
      ...opts,
      focus: "pay attention to the retry loop",
    });
    expect(p).toContain("pay attention to the retry loop");
  });
});

describe("preflightReviewerFor", () => {
  afterEach(() => {
    delete process.env.OPENSESSION_REVIEW_INVERSION;
  });

  test("always picks the opposite family of the authoring session", () => {
    expect(preflightReviewerFor("claude-fable-5")).toEqual({
      model: "gpt-5.6-sol",
      authorFamily: "anthropic",
    });
    expect(preflightReviewerFor("opencode/openai/gpt-5.6-sol")).toEqual({
      model: "claude-fable-5",
      authorFamily: "openai",
    });
    // Unknown/unset author model defaults to the Anthropic pool → GPT reviews.
    expect(preflightReviewerFor(undefined).model).toBe("gpt-5.6-sol");
  });

  test("honors the inversion kill switch (caller falls back to configured model)", () => {
    process.env.OPENSESSION_REVIEW_INVERSION = "0";
    expect(preflightReviewerFor("claude-fable-5").model).toBeNull();
  });
});
