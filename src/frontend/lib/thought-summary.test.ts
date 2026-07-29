import { expect, test } from "bun:test";
import { thoughtSummary } from "./thought-summary";

test("thinking previews collapse markdown into a readable line", () => {
  expect(
    thoughtSummary(
      "## Check the route\n\nI need to inspect `src/pages/feed.xml.ts` and **verify** the generated link."
    )
  ).toBe("Check the route I need to inspect src/pages/feed.xml.ts and verify the generated link.");
});

test("thinking previews keep link labels and drop fenced markers", () => {
  expect(thoughtSummary("```ts\nconst slug = post.id\n```\nSee [the route](https://example.com)."))
    .toBe("const slug = post.id See the route.");
});
