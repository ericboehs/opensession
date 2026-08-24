import { describe, expect, test } from "bun:test";
import { buildRunInstructions } from "./run-instructions";

describe("buildRunInstructions", () => {
  test("keeps a standard interactive prompt minimal", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      osSessionId: "os-test",
      inProcessMcp: { "opensession-sessions": {} },
    });

    expect(prompt.match(/^## .+$/gm)).toEqual([
      "## Data handling",
      "## Finish your turns",
      "## References",
      "## PR attribution",
      "## New sessions",
      "## Media",
    ]);
    expect(prompt).toContain(
      "For PRs outside the current primary repository, write `<repo>#<number>`, never bare `#<number>`."
    );
    expect(prompt.length).toBeLessThan(700);
  });
});
