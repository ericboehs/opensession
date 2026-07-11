import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown session links", () => {
  it("turns a session-id codespan into a link", () => {
    const html = renderMarkdown(
      "Delegated to `bks-019f24b5-f31d-7000-a48f-31a9e829c4ae` reporting back.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-f31d-7000-a48f-31a9e829c4ae"',
    );
    // not rendered as a plain <code> chip
    expect(html).not.toContain(
      "<code>bks-019f24b5-f31d-7000-a48f-31a9e829c4ae</code>",
    );
  });

  it("links a bare (un-backticked) uuidv7 session id in prose", () => {
    const html = renderMarkdown(
      "Started session bks-019f24b5-daa6-7000-8231-6c7ff13672ae as a worker.",
    );
    expect(html).toContain('class="session-link"');
    expect(html).toContain(
      'data-session-id="bks-019f24b5-daa6-7000-8231-6c7ff13672ae"',
    );
  });

  it("leaves ordinary codespans as code", () => {
    const html = renderMarkdown("Run `bun test` to check.");
    expect(html).toContain("<code>bun test</code>");
    expect(html).not.toContain("session-link");
  });

  it("does not misfire on non-session text", () => {
    const html = renderMarkdown("The bks-abbreviation is fine here.");
    expect(html).not.toContain("session-link");
  });
});

describe("renderMarkdown strikethrough (double-tilde only)", () => {
  it("does not strike through single tildes in code-ish content", () => {
    // ReScript labeled args, approximate numbers, home paths — all bare tildes.
    for (const src of [
      "updateUpdatedAt(~storyID=query.id, ~sceneID=scene.id)",
      "call foo(~storyID) then bar(~sceneID) next",
      "That leaves ~352 across ~165 files",
      "edit ~/.config and ~/.bashrc",
    ]) {
      expect(renderMarkdown(src)).not.toContain("<del>");
    }
  });

  it("still renders real ~~strikethrough~~", () => {
    expect(renderMarkdown("this is ~~struck~~ text")).toContain("<del>struck</del>");
  });
});
