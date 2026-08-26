import { describe, expect, test } from "bun:test";
import {
  expandReviewRequestLogins,
  normalizeReviewTeamSlug,
  reviewRequestRemovalSpecs,
} from "./github-review-requests";

describe("expandReviewRequestLogins", () => {
  test("expands team requests, deduplicates users, and excludes the author", () => {
    const teamLogins = new Map([
      ["infra-reviewers", ["happylinks", "jfrolich", "soutar"]],
    ]);

    expect(
      expandReviewRequestLogins(
        [
          { login: "kentdebruin" },
          { login: "happylinks" },
          { slug: "infra-reviewers" },
        ],
        teamLogins,
        "jfrolich",
      ),
    ).toEqual(["kentdebruin", "happylinks", "soutar"]);
  });
});

test("normalizes the owner-prefixed slug returned by gh pr list", () => {
  expect(normalizeReviewTeamSlug("tellahq/infra-reviewers")).toBe(
    "infra-reviewers",
  );
});

describe("reviewRequestRemovalSpecs", () => {
  test("qualifies a team exactly once, whichever slug shape it arrives in", () => {
    expect(
      reviewRequestRemovalSpecs(
        // `gh pr view` returns the slug owner-prefixed; a webhook payload
        // returns it bare. Both must come back as one `owner/slug`.
        [{ slug: "tellahq/infra-reviewers" }, { slug: "infra-reviewers" }],
        "tellahq",
      ),
    ).toEqual(["tellahq/infra-reviewers"]);
  });

  test("keeps user logins as they are", () => {
    expect(
      reviewRequestRemovalSpecs(
        [{ login: "happylinks" }, { slug: "tellahq/infra-reviewers" }],
        "tellahq",
      ),
    ).toEqual(["happylinks", "tellahq/infra-reviewers"]);
  });
});
