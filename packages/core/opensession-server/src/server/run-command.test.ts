import { describe, expect, it } from "bun:test";
import { runCommand } from "./run-command";

describe("runCommand", () => {
  it("captures output and preserves the exit status", async () => {
    const result = await runCommand([
      process.execPath,
      "-e",
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
    ]);

    expect(result).toEqual({ status: 7, stdout: "out", stderr: "err" });
  });

  it("kills commands that exceed their timeout", async () => {
    const started = performance.now();
    const result = await runCommand(
      [process.execPath, "-e", "await Bun.sleep(500)"],
      { timeoutMs: 20 },
    );

    expect(result.status).toBeNull();
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("returns spawn errors without throwing", async () => {
    const result = await runCommand(["/definitely/not/a/real/command"]);

    expect(result.status).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
