import { afterEach, describe, expect, test } from "bun:test";
import {
  __setGhBackoffForTest,
  ghBackoffUntil,
  ghRateLimited,
} from "./github-limit";

let restoreGraphql = 0;
let restoreRest = 0;
afterEach(() => {
  __setGhBackoffForTest(restoreGraphql, "graphql");
  __setGhBackoffForTest(restoreRest, "rest");
});

describe("GitHub rate-limit resources", () => {
  test("GraphQL exhaustion does not suppress REST", () => {
    restoreGraphql = __setGhBackoffForTest(Date.now() + 60_000, "graphql");
    restoreRest = __setGhBackoffForTest(0, "rest");

    expect(ghRateLimited("graphql")).toBe(true);
    expect(ghBackoffUntil("graphql")).toBeGreaterThan(Date.now());
    expect(ghRateLimited("rest")).toBe(false);
    expect(ghBackoffUntil("rest")).toBe(0);
  });

  test("REST exhaustion does not suppress GraphQL", () => {
    restoreGraphql = __setGhBackoffForTest(0, "graphql");
    restoreRest = __setGhBackoffForTest(Date.now() + 60_000, "rest");

    expect(ghRateLimited("graphql")).toBe(false);
    expect(ghRateLimited("rest")).toBe(true);
  });
});
