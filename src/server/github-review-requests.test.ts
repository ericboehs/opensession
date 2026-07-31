import { describe, expect, test } from "bun:test";
import {
  expandReviewRequestLogins,
  normalizeReviewTeamSlug,
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
