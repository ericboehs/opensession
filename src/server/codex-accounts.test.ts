import { describe, expect, test } from "bun:test";
import { hrwScore } from "./codex-accounts";

// PINNED-HASH tests (pattern from meridian PR #615): session→account affinity
// is a pure function of these scores. If any assertion here fails, the change
// reshuffles EVERY session's account assignment and cold-starts their
// provider prompt caches — that must be a deliberate decision, not a drive-by.
describe("hrwScore (rendezvous affinity)", () => {
  test("pinned values are stable across versions", () => {
    expect(hrwScore("bks-019f7182-a597-7000-96b0-50fdc06f8694", "eae22618-bd72-45ab-8307-4949b5e409cd")).toBe(1742935766);
    expect(hrwScore("bks-019f7182-a597-7000-96b0-50fdc06f8694", "13fde4f9-e1f2-486c-8e04-1d0f322b7636")).toBe(3956256899);
    expect(hrwScore("bks-test-session", "eae22618-bd72-45ab-8307-4949b5e409cd")).toBe(3693026164);
    expect(hrwScore("bks-test-session", "13fde4f9-e1f2-486c-8e04-1d0f322b7636")).toBe(1275860373);
  });

  test("different sessions can land on different accounts (spread exists)", () => {
    // With the two pinned pairs above, session 1 prefers account B and
    // session 2 prefers account A — the whole point of rendezvous hashing.
    const s1 =
      hrwScore("bks-019f7182-a597-7000-96b0-50fdc06f8694", "13fde4f9-e1f2-486c-8e04-1d0f322b7636") >
      hrwScore("bks-019f7182-a597-7000-96b0-50fdc06f8694", "eae22618-bd72-45ab-8307-4949b5e409cd");
    const s2 =
      hrwScore("bks-test-session", "eae22618-bd72-45ab-8307-4949b5e409cd") >
      hrwScore("bks-test-session", "13fde4f9-e1f2-486c-8e04-1d0f322b7636");
    expect(s1).toBe(true);
    expect(s2).toBe(true);
  });
});
