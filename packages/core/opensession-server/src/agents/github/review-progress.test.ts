import { describe, expect, test } from "bun:test";
import { isReviewProgressForHead } from "./github-rest";

const SHA = "e903b371cd22276add8ff759f17fc659ba123c25";

describe("isReviewProgressForHead", () => {
  test("matches the current progress placeholder for the same head", () => {
    expect(
      isReviewProgressForHead(
        "<!-- os-review -->\n### 🤖 OS review\n\n🔄 Reviewing `e903b37`… · open session",
        SHA,
      ),
    ).toBe(true);
  });

  test("accepts placeholders without a displayed SHA", () => {
    expect(
      isReviewProgressForHead(
        "<!-- os-review -->\n### 🤖 OS review\n\n🔄 Reviewing… · open session",
        SHA,
      ),
    ).toBe(true);
  });

  test("rejects a placeholder for a different head", () => {
    expect(
      isReviewProgressForHead(
        "<!-- os-review -->\n### 🤖 OS review\n\n🔄 Reviewing `abcdef0`… · open session",
        SHA,
      ),
    ).toBe(false);
  });

  test("rejects completed and outdated review comments", () => {
    expect(
      isReviewProgressForHead(
        "<!-- os-review -->\n### 🤖 OS review · approve\n\nLooks good.\n\nReviewed `e903b37`.",
        SHA,
      ),
    ).toBe(false);
    expect(
      isReviewProgressForHead(
        "<!-- os-review-outdated -->\n<details><summary>Outdated review</summary></details>",
        SHA,
      ),
    ).toBe(false);
  });
});
