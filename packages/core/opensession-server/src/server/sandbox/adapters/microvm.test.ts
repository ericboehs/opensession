import { describe, expect, test } from "bun:test";
import { assertDialbackReachable, type RemoteDriver } from "./bootstrap";
import {
  microvmBootstrapDriver,
  parseMicrovmEgressDestination,
} from "./microvm";

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

  test("the dial-back probe uses the explicit private callback base", async () => {
    let command = "";
    const driver = driverWith(async (next) => {
      command = next;
      return { exitCode: 0, stdout: "200", stderr: "" };
    });

    await assertDialbackReachable(
      driver,
      "microvm",
      "wss://microvm.internal.example/",
    );

    expect(command).toContain("https://microvm.internal.example/");
    expect(command).not.toContain("publicIngress");
  });
});

describe("MicroVM automation egress", () => {
  test("accepts URLs, host ports, IPv4 addresses, and CIDRs", () => {
    expect(parseMicrovmEgressDestination("https://api.example.com/path?secret=x")).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(parseMicrovmEgressDestination("callback.example.com:8443")).toEqual({
      host: "callback.example.com",
      port: 8443,
    });
    expect(parseMicrovmEgressDestination("203.0.113.8")).toEqual({
      host: "203.0.113.8",
    });
    expect(parseMicrovmEgressDestination("10.0.0.0/24")).toEqual({
      host: "10.0.0.0/24",
    });
  });

  test("rejects wildcard and non-network destinations", () => {
    expect(() => parseMicrovmEgressDestination("*.example.com")).toThrow("wildcards");
    expect(() => parseMicrovmEgressDestination("file:///etc/passwd")).toThrow(
      "unsupported",
    );
  });
});
