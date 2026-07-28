import { describe, expect, test } from "bun:test";
import {
  cachedPrDetailsForSession,
  isNoPrError,
  prApiErrorMessage,
  reconcilePrDetails,
  type PrDetails,
} from "./pr-info";
import type { UnifiedSession } from "./types";

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

describe("cached session PR details", () => {
  const session = {
    repo: "tella-fusion",
    branch: "feature",
    prNumber: 5016,
    prUrl: "https://github.com/tellahq/tella-fusion/pull/5016",
    prState: "MERGED",
    prTitle: "Merged feature",
    prAdditions: 10,
    prDeletions: 2,
    prs: [
      {
        repo: "tella-fusion",
        branch: "feature",
        source: "primary",
        number: 5016,
        url: "https://github.com/tellahq/tella-fusion/pull/5016",
        state: "MERGED",
        title: "Merged feature",
      },
      {
        repo: "shared-infra",
        branch: "infra-feature",
        source: "attached",
      },
    ],
  } as UnifiedSession;

  test("serves the known merged PR when the detail query is unavailable", () => {
    const fallback = cachedPrDetailsForSession(session, "tella-fusion", "feature");

    expect(fallback?.state).toBe("MERGED");
    expect(fallback?.number).toBe(5016);
    expect(fallback?.headRefName).toBe("feature");
  });

  test("does not invent a PR for a bare attached branch", () => {
    expect(
      cachedPrDetailsForSession(session, "shared-infra", "infra-feature"),
    ).toBeNull();
  });

  test("keeps irreversible merged state over stale OPEN details", () => {
    const fallback = cachedPrDetailsForSession(
      session,
      "tella-fusion",
      "feature",
    )!;
    const stale = { ...fallback, state: "OPEN" } as PrDetails;

    expect(reconcilePrDetails(stale, fallback)?.state).toBe("MERGED");
    expect(reconcilePrDetails(stale, fallback)?.isDraft).toBe(false);
  });

  test("does not synthesize actionable details for an open PR", () => {
    expect(
      cachedPrDetailsForSession(
        { ...session, prState: "OPEN", prs: undefined } as UnifiedSession,
        "tella-fusion",
        "feature",
      ),
    ).toBeNull();
  });
});
