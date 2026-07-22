import { describe, expect, test } from "bun:test";
import { isNoPrError, prApiErrorMessage } from "./pr-info";

describe("isNoPrError", () => {
  test("only accepts GitHub's explicit no-PR response", () => {
    expect(isNoPrError('no pull requests found for branch "missing"')).toBe(true);
    expect(isNoPrError("Could not resolve to a PullRequest with the number of 999")).toBe(true);
    expect(isNoPrError("Could not resolve host: api.github.com")).toBe(false);
    expect(isNoPrError("Could not resolve to a Repository with the name 'owner/repo'")).toBe(false);
  });
});

describe("prApiErrorMessage", () => {
  test("explains GitHub rate limits without exposing CLI output", () => {
    expect(prApiErrorMessage("GraphQL: API rate limit already exceeded for user ID 123")).toBe(
      "GitHub's API rate limit has been reached. Try again after it resets.",
    );
  });

  test("explains authentication failures", () => {
    expect(prApiErrorMessage("HTTP 401: Bad credentials")).toBe(
      "GitHub authentication failed. Check the GitHub connection.",
    );
  });

  test("keeps unknown upstream failures generic", () => {
    expect(prApiErrorMessage("stream error: INTERNAL_ERROR")).toBe(
      "GitHub's pull request API is unavailable right now.",
    );
  });
});
