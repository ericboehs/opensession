import { describe, expect, test } from "bun:test";
import type { RemoteDriver } from "./bootstrap";
import { microvmBootstrapDriver } from "./microvm";

function driverWith(
  exec: RemoteDriver["exec"],
): RemoteDriver {
  return {
    exec,
    async execBackground() {},
    async writeFile() {},
    async ensureStarted() {},
  };
}

describe("microvmBootstrapDriver", () => {
  test("retries a transient restored-guest control-socket closure", async () => {
    let calls = 0;
    const driver = microvmBootstrapDriver(
      driverWith(async () => {
        calls++;
        return calls === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "The socket connection was closed unexpectedly",
            }
          : { exitCode: 0, stdout: "ready\n", stderr: "" };
      }),
    );

    expect(await driver.exec("id")).toEqual({
      exitCode: 0,
      stdout: "ready\n",
      stderr: "",
    });
    expect(calls).toBe(2);
  });

  test("does not retry an ordinary command failure", async () => {
    let calls = 0;
    const driver = microvmBootstrapDriver(
      driverWith(async () => {
        calls++;
        return { exitCode: 7, stdout: "", stderr: "permission denied" };
      }),
    );

    expect((await driver.exec("id")).exitCode).toBe(7);
    expect(calls).toBe(1);
  });
});
