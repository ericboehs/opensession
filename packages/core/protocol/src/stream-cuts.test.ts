import { describe, expect, test } from "bun:test";
import { advanceReveal } from "./stream-cuts";

describe("advanceReveal", () => {
  test("text with no boundary at all reveals whole", () => {
    expect(advanceReveal("0123456789", 0, 2)).toBe(10);
  });

  test("takes the furthest word cut within the budget", () => {
    expect(advanceReveal("aa bb cc dd.", 0, 9)).toBe(9);
  });

  test("takes the nearest word cut when the budget lands mid-word", () => {
    expect(advanceReveal("Streaming should feel typed", 0, 2)).toBe(10);
  });

  test("the tail after the last boundary snaps to the end", () => {
    // What a viewer holds ends on a sender-vetted boundary, so the length
    // itself is safe.
    expect(advanceReveal("aa bb cc dd.", 9, 2)).toBe(12);
  });

  test("never cuts inside an open code span", () => {
    const text = "run `a b c` now please";
    // Walk the whole text the way the reveal loop does and check every stop.
    let at = 0;
    while (at < text.length) {
      const next = advanceReveal(text, at, 3);
      expect(next).toBeGreaterThan(at);
      const shown = text.slice(0, next);
      expect((shown.match(/`/g) ?? []).length % 2).toBe(0);
      at = next;
    }
  });

  test("never cuts inside an open bold run", () => {
    const text = "Second **bold words** here";
    // The budget lands inside "**bold ", so the cut skips to where the run closes.
    expect(advanceReveal(text, 7, 2)).toBe(22);
    expect(text.slice(0, 22)).toBe("Second **bold words** ");
  });

  test("reveals a fence opener only together with its first code line", () => {
    const text = "```ts\nconst a = 1;\nconst b = 2;\n```\n";
    expect(advanceReveal(text, 0, 2)).toBe(19); // "```ts\nconst a = 1;\n"
    expect(advanceReveal(text, 19, 2)).toBe(32); // whole next code line
    expect(advanceReveal(text, 32, 2)).toBe(36); // the closing fence
  });

  test("does not cut inside a code line", () => {
    const text = "```\nlet total = a + b;\n";
    expect(advanceReveal(text, 4, 3)).toBe(text.length);
  });

  test("a lone list or heading marker is not a cut", () => {
    expect(advanceReveal("- item one\n- item two\n", 0, 2)).toBe(7);
    expect(advanceReveal("## Heading words here\n", 0, 2)).toBe(11);
  });
});
