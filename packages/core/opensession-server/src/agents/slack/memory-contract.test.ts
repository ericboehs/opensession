import { describe, expect, test } from "bun:test";
import {
  MEMORY_SUMMARY_MAX_CHARS,
  MemoryListInputSchema,
  StoreMemoryInputSchema,
} from "./memory-contract";

describe("memory v2 tool contract", () => {
  test("accepts an atomic durable record", () => {
    const result = StoreMemoryInputSchema.safeParse({
      summary: "Preview servers bind to loopback only.",
      kind: "constraint",
      scope: "repo",
      tags: ["preview", "network"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects summaries that would recreate long-form memory", () => {
    const tooLong = StoreMemoryInputSchema.safeParse({
      summary: "x".repeat(MEMORY_SUMMARY_MAX_CHARS + 1),
      kind: "gotcha",
      scope: "repo",
    });
    const tooManySentences = StoreMemoryInputSchema.safeParse({
      summary: "First fact. Second fact. Third fact.",
      kind: "gotcha",
      scope: "repo",
    });
    expect(tooLong.success).toBe(false);
    expect(tooManySentences.success).toBe(false);
  });

  test("requires an expiry for temporary status", () => {
    const result = StoreMemoryInputSchema.safeParse({
      summary: "The migration is temporarily paused.",
      kind: "status",
      scope: "team",
    });
    expect(result.success).toBe(false);
  });

  test("bounds list pages", () => {
    expect(MemoryListInputSchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(MemoryListInputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });
});
