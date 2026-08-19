import { describe, expect, test } from "bun:test";
import {
  shouldHandleAppMention,
  shouldHandleDirectMessage,
} from "./event-routing";

describe("shouldHandleAppMention", () => {
  test("handles user mentions", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        user: "U123",
        text: "<@U999> help",
      }),
    ).toBe(true);
  });

  test("ignores channel archive system messages", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        subtype: "channel_archive",
        user: "U999",
        text: "<@U999> archived the channel <#C123>",
      }),
    ).toBe(false);
  });

  test("ignores other app mention system messages", () => {
    expect(
      shouldHandleAppMention({
        type: "app_mention",
        subtype: "channel_unarchive",
        user: "U999",
        text: "<@U999> unarchived the channel <#C123>",
      }),
    ).toBe(false);
  });
});

describe("shouldHandleDirectMessage", () => {
  test("handles user messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        channel_type: "im",
        user: "U123",
        text: "Help",
      }),
    ).toBe(true);
  });

  test("handles user file shares", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        subtype: "file_share",
        channel_type: "im",
        user: "U123",
      }),
    ).toBe(true);
  });

  test("ignores Slack channel archive messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        subtype: "channel_archive",
        channel_type: "im",
        user: "USLACK",
        text: "<@U999> archived the channel <#C123>",
      }),
    ).toBe(false);
  });

  test("ignores bot messages", () => {
    expect(
      shouldHandleDirectMessage({
        type: "message",
        channel_type: "im",
        user: "U123",
        bot_id: "B123",
      }),
    ).toBe(false);
  });
});
