import { describe, expect, test } from "bun:test";
import { isClaudeBridgeLaunchError } from "./runner-shared";

describe("isClaudeBridgeLaunchError", () => {
  test("matches the two shapes the agent SDK emits", () => {
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary at /home/ubuntu/projects/tella-backstage/node_modules/.bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer.",
      ),
    ).toBe(true);
  });

  test("does not claim faults that belong to another rotation lane", () => {
    // Usage limits and subscription faults have their own classifiers, and a
    // model's own words about a launch must never sideline the account.
    expect(isClaudeBridgeLaunchError("Claude AI usage limit reached")).toBe(false);
    expect(
      isClaudeBridgeLaunchError("Claude Max subscription issue. Check your subscription status."),
    ).toBe(false);
    expect(isClaudeBridgeLaunchError("the deploy script failed to launch the server")).toBe(false);
    expect(isClaudeBridgeLaunchError("command not found: claude")).toBe(false);
    expect(isClaudeBridgeLaunchError("")).toBe(false);
  });
});
