import { describe, expect, test } from "bun:test";
import { checkRegistrationPending } from "./autofix-gates";

describe("auto-fix completion gates", () => {
  test("does not accept an empty check rollup until the registration grace passes", () => {
    expect(checkRegistrationPending(0, 1_000, 1_000, 30_000)).toBe(true);
    expect(checkRegistrationPending(0, 1_000, 30_999, 30_000)).toBe(true);
    expect(checkRegistrationPending(0, 1_000, 31_000, 30_000)).toBe(false);
  });

  test("registered checks bypass the empty-rollup grace", () => {
    expect(checkRegistrationPending(1, 1_000, 1_000, 30_000)).toBe(false);
  });
});
