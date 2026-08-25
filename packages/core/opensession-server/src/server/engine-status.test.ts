import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { engineStatus } from "./engine-status";

const original = process.env.OPENSESSION_PI_CONFIG;
let dir = "";
afterEach(() => {
  if (original === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = original;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("engine status", () => {
  test("reports a disabled Pi engine as the first blocker", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-status-"));
    const path = join(dir, "pi.json");
    writeFileSync(path, JSON.stringify({ enabled: false }));
    process.env.OPENSESSION_PI_CONFIG = path;
    const status = engineStatus();
    expect(status.piEnabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.fixableInApp).toBe(true);
    expect(status.blocker).toContain("Pi engine");
  });
});
