import { describe, expect, test } from "bun:test";
import { slackRepoRoutingText } from "./mention-intent";

describe("slackRepoRoutingText", () => {
  test("carries the channel, message, and thread context into Auto routing", () => {
    expect(
      slackRepoRoutingText("Fix the deployment", {
        channelName: "infra",
        context: "The stage stack stopped applying changes.",
      }),
    ).toBe(
      "Channel: #infra\n\nMessage:\nFix the deployment\n\nThread context:\nThe stage stack stopped applying changes.",
    );
  });

  test("keeps every routing signal inside the shared router's task window", () => {
    const text = slackRepoRoutingText("m".repeat(2_000), {
      channelName: "c".repeat(200),
      context: `${"x".repeat(630)}context-end`,
    });

    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toContain("context-end");
  });
});
