import { describe, expect, test } from "bun:test";
import { rebuildInvalidatedPreviewPool } from "./preview-pool";

describe("default branch preview-pool rebuild", () => {
  test("does not refill a golden-backed pool when its rebuild fails", async () => {
    let refills = 0;

    const rebuilt = await rebuildInvalidatedPreviewPool(
      "docker",
      async () => false,
      async () => {
        refills++;
      },
    );

    expect(rebuilt).toBe(false);
    expect(refills).toBe(0);
  });

  test("refills after success and lets Daytona provision without a golden", async () => {
    let rebuilds = 0;
    let refills = 0;
    const rebuild = async () => {
      rebuilds++;
      return true;
    };
    const refill = async () => {
      refills++;
    };

    await expect(rebuildInvalidatedPreviewPool("microvm", rebuild, refill)).resolves.toBe(true);
    await expect(rebuildInvalidatedPreviewPool("daytona", rebuild, refill)).resolves.toBe(true);
    expect(rebuilds).toBe(1);
    expect(refills).toBe(2);
  });
});
