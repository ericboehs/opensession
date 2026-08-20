import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "./maintenance";

describe("rotateLog", () => {
  test("rotates a log over the cap: truncates in place and keeps .1", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    const log = join(dir, "server.log");
    const body = "x".repeat(2048);
    writeFileSync(log, body);

    const freed = rotateLog(log, 1024); // cap below current size

    expect(freed).toBe(2048);
    expect(statSync(log).size).toBe(0); // live log truncated
    expect(readFileSync(`${log}.1`, "utf8")).toBe(body); // rotation preserved
  });

  test("leaves a log under the cap untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    const log = join(dir, "server.log");
    writeFileSync(log, "small");

    const freed = rotateLog(log, 1024);

    expect(freed).toBe(0);
    expect(statSync(log).size).toBe(5);
    expect(() => statSync(`${log}.1`)).toThrow(); // no rotation created
  });

  test("no-ops on a missing log", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-maint-"));
    expect(rotateLog(join(dir, "nope.log"), 1024)).toBe(0);
  });
});
