import { describe, expect, test } from "bun:test";
import { chooseSessionLane, laneHash, type LaneLoad } from "./lane-placement";

const idle = (count: number): LaneLoad[] =>
  Array.from({ length: count }, () => ({ queued: 0, executing: 0 }));

describe("chooseSessionLane", () => {
  test("is deterministic for equal loads and matches the primary hash", () => {
    const lanes = idle(8);
    for (const sessionId of ["a", "session-123", "bks_0192", "🚀"]) {
      const primary = laneHash(sessionId, 0) % lanes.length;
      expect(chooseSessionLane(sessionId, lanes)).toBe(primary);
      // Deterministic: same inputs, same lane.
      expect(chooseSessionLane(sessionId, lanes)).toBe(primary);
    }
  });

  test("single lane always places on lane 0", () => {
    expect(chooseSessionLane("anything", idle(1))).toBe(0);
  });

  test("prefers the less loaded of its two candidates", () => {
    const lanes = idle(8);
    // Find a session whose two candidates differ.
    let sessionId = "";
    let first = 0;
    let second = 0;
    for (let n = 0; n < 10_000; n += 1) {
      const candidate = `session-${n}`;
      const a = laneHash(candidate, 0) % lanes.length;
      const b = laneHash(candidate, 0x9e37_79b9) % lanes.length;
      if (a !== b) {
        sessionId = candidate;
        first = a;
        second = b;
        break;
      }
    }
    expect(sessionId).not.toBe("");
    // Equal load keeps the primary candidate.
    expect(chooseSessionLane(sessionId, lanes)).toBe(first);
    // Loaded primary moves the placement to the second candidate.
    lanes[first] = { queued: 3, executing: 1 };
    expect(chooseSessionLane(sessionId, lanes)).toBe(second);
    // But an equally loaded second candidate keeps the primary (ties stick).
    lanes[second] = { queued: 4, executing: 0 };
    expect(chooseSessionLane(sessionId, lanes)).toBe(first);
  });

  test("never places outside the lane range and spreads sessions", () => {
    const lanes = idle(5);
    const seen = new Set<number>();
    for (let n = 0; n < 500; n += 1) {
      const lane = chooseSessionLane(`spread-${n}`, lanes);
      expect(lane).toBeGreaterThanOrEqual(0);
      expect(lane).toBeLessThan(lanes.length);
      seen.add(lane);
    }
    expect(seen.size).toBe(lanes.length);
  });

  test("rejects an empty lane set", () => {
    expect(() => chooseSessionLane("x", [])).toThrow();
  });
});
