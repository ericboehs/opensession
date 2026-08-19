import { describe, expect, test } from "bun:test";
import { boxCommandPlaneUnavailable, boxMachineType, boxNativeFilePath } from "./box";

describe("Box machine profiles", () => {
  test("maps the three provider-supported resource combinations", () => {
    expect(boxMachineType({ cpu: 2, memoryMb: 4_096, diskGb: 40 })).toBe("small");
    expect(boxMachineType({ cpu: 4, memoryMb: 8_192, diskGb: 80 })).toBe("default");
    expect(boxMachineType({ cpu: 8, memoryMb: 16_384, diskGb: 100 })).toBe("large");
  });

  test("uses default when no project profile exists and rejects arbitrary combinations", () => {
    expect(boxMachineType()).toBe("default");
    expect(() => boxMachineType({ cpu: 4, memoryMb: 4_096, diskGb: 80 })).toThrow(
      "Choose one of Box's Small, Default, or Large machine sizes",
    );
  });
});

describe("Box persistent file paths", () => {
  test("maps the cross-provider home to Box's native durable home", () => {
    expect(boxNativeFilePath("/home/ubuntu")).toBe("/home/user");
    expect(boxNativeFilePath("/home/ubuntu/.opensession/spec.json")).toBe(
      "/home/user/.opensession/spec.json",
    );
    expect(boxNativeFilePath("/tmp/output")).toBe("/tmp/output");
  });
});

describe("Box command readiness", () => {
  test("only retries explicit no-command 409 states", () => {
    expect(boxCommandPlaneUnavailable({ status: 409, code: "machine_not_running" })).toBe(true);
    expect(boxCommandPlaneUnavailable({ status: 409, code: "box_starting" })).toBe(true);
    expect(boxCommandPlaneUnavailable({ status: 502, code: "box_direct_failed" })).toBe(false);
    expect(boxCommandPlaneUnavailable({ status: 409, code: "other" })).toBe(false);
  });
});
