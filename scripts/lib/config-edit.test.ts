import { describe, expect, test } from "bun:test";
import { MACOS_TAILSCALE_CLI, tailnetIp } from "./config-edit";

type Result = { exitCode: number; stdout: { toString(): string } };

function result(stdout: string, exitCode = 0): Result {
  return { exitCode, stdout: { toString: () => stdout } };
}

describe("tailnetIp", () => {
  test("uses tailscale from PATH first", () => {
    const commands: string[][] = [];
    const address = tailnetIp({
      platform: "darwin",
      exists: () => true,
      run: (command) => {
        commands.push(command);
        return result("100.64.12.34\n");
      },
    });

    expect(address).toBe("100.64.12.34");
    expect(commands).toEqual([["tailscale", "ip", "-4"]]);
  });

  test("falls back to the bundled macOS CLI when tailscale is not on PATH", () => {
    const commands: string[][] = [];
    const address = tailnetIp({
      platform: "darwin",
      exists: (path) => path === MACOS_TAILSCALE_CLI,
      run: (command) => {
        commands.push(command);
        if (command[0] === "tailscale") throw new Error("executable not found");
        return result("100.100.20.30\n");
      },
    });

    expect(address).toBe("100.100.20.30");
    expect(commands).toEqual([
      ["tailscale", "ip", "-4"],
      [MACOS_TAILSCALE_CLI, "ip", "-4"],
    ]);
  });

  test("does not probe the macOS app bundle on other platforms", () => {
    const commands: string[][] = [];
    const address = tailnetIp({
      platform: "linux",
      exists: () => true,
      run: (command) => {
        commands.push(command);
        return result("", 1);
      },
    });

    expect(address).toBeUndefined();
    expect(commands).toEqual([["tailscale", "ip", "-4"]]);
  });

  test("returns undefined when neither macOS CLI can report an address", () => {
    const address = tailnetIp({
      platform: "darwin",
      exists: () => true,
      run: () => result("", 1),
    });

    expect(address).toBeUndefined();
  });
});
