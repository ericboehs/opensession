import { describe, expect, test } from "bun:test";
import { slackFileRefs } from "./slack-api";

describe("slackFileRefs", () => {
  test("maps Slack file objects to small refs", () => {
    const refs = slackFileRefs([
      {
        id: "F123",
        name: "shot.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/dl/shot.png",
        url_private: "https://files.slack.com/shot.png",
        size: 1234,
      },
    ]);
    expect(refs).toEqual([
      {
        id: "F123",
        name: "shot.png",
        mimetype: "image/png",
        url: "https://files.slack.com/dl/shot.png",
        size: 1234,
      },
    ]);
  });

  test("falls back to url_private and drops entries with no URL", () => {
    const refs = slackFileRefs([
      { id: "F1", name: "a.pdf", mimetype: "application/pdf", url_private: "https://x/a.pdf" },
      { id: "F2", name: "tombstone" },
      null,
    ]);
    expect(refs.map((r) => r.id)).toEqual(["F1"]);
    expect(refs[0]!.url).toBe("https://x/a.pdf");
    expect(refs[0]!.size).toBe(0);
  });

  test("handles undefined", () => {
    expect(slackFileRefs(undefined)).toEqual([]);
  });
});
