import { afterEach, expect, test } from "bun:test";
import {
  __setRunOutcomeProjectorForTest,
  recordRunOutcome,
} from "./session-cache";

afterEach(() => {
  __setRunOutcomeProjectorForTest(undefined);
});

test("recordRunOutcome waits for physical projection completion", async () => {
  const gate = Promise.withResolvers<void>();
  __setRunOutcomeProjectorForTest(async () => {
    await gate.promise;
  });
  const projection = recordRunOutcome("outcome-wait", null);
  let completed = false;
  void projection.then(() => {
    completed = true;
  });

  await Promise.resolve();
  expect(completed).toBe(false);
  gate.resolve();
  await projection;
  expect(completed).toBe(true);
});

test("recordRunOutcome exposes physical projection rejection", async () => {
  __setRunOutcomeProjectorForTest(async () => {
    throw new Error("outcome projection rejected");
  });

  await expect(recordRunOutcome("outcome-rejection", null)).rejects.toThrow(
    "outcome projection rejected",
  );
});
