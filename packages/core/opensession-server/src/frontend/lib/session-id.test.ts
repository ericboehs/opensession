import { describe, expect, test } from "bun:test";
import { newClientSessionId } from "./session-id";

describe("newClientSessionId", () => {
  test("mints an os UUIDv7 with the supplied timestamp", () => {
    const id = newClientSessionId(1_700_000_000_000);
    expect(id).toMatch(
      /^os-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const compactTimestamp = id.slice(3).replaceAll("-", "").slice(0, 12);
    expect(Number.parseInt(compactTimestamp, 16)).toBe(1_700_000_000_000);
  });
});
