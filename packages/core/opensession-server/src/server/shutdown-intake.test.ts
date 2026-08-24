import { describe, expect, test } from "bun:test";

const read = (relative: string) =>
  Bun.file(new URL(relative, import.meta.url)).text();

describe("shutdown intake fence", () => {
  test("parks automation scheduler, webhook, and direct runs", async () => {
    const source = await read("./automations.ts");
    const run = source.indexOf("export async function runAutomation(");
    const count = source.indexOf("runningCounts.set", run);
    expect(source.indexOf("if (isShuttingDown())", run)).toBeLessThan(count);
    expect(source).toContain(
      "schedulerInterval = setInterval(() => {\n    if (isShuttingDown()) return;",
    );
    expect(source).toContain(
      'return Response.json({ error: "Server restarting" }, { status: 503 })',
    );
  });

  test("parks new GitHub reviews before claiming their lock", async () => {
    const source = await read("../agents/github/review.ts");
    const review = source.indexOf("export async function runReview(");
    expect(source.indexOf("if (isShuttingDown())", review)).toBeLessThan(
      source.indexOf('claimLock("review"', review),
    );
    expect(source).toContain(
      "if (cancellationRequested() || isShuttingDown())",
    );
  });

  test("does not start a queued boot recovery after shutdown begins", async () => {
    const source = await read("./agent-runner.ts");
    const recovery = source.indexOf("const recoveryTask = (");
    const start = source.indexOf("const start = async () =>", recovery);
    expect(source.indexOf("if (started || isShuttingDown()) return", start)).toBeGreaterThan(start);
    expect(source.indexOf("if (started || isShuttingDown()) return", start)).toBeLessThan(
      source.indexOf("started = true", start),
    );
  });
});
