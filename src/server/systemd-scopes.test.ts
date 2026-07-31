import { describe, expect, test } from "bun:test";
import {
  ENGINE_SLICE,
  PREVIEW_SLICE,
  engineScopeSystemdArgs,
  previewScopeSystemdArgs,
  previewScopeUnit,
} from "./systemd-scopes";

describe("systemd scope resource controls", () => {
  test("detached engines get bounded memory, swap, tasks, and an aggregate slice", () => {
    expect(engineScopeSystemdArgs({})).toEqual([
      `--slice=${ENGINE_SLICE}`,
      "--property=MemoryHigh=6G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=1024",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("previews get a separate budget and leave CPU headroom", () => {
    expect(previewScopeSystemdArgs({})).toEqual([
      `--slice=${PREVIEW_SLICE}`,
      "--property=MemoryHigh=8G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=768",
      "--property=CPUQuota=600%",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("trusted env overrides tune limits while malformed values fall back", () => {
    expect(
      engineScopeSystemdArgs({
        OPENSESSION_ENGINE_MEMORY_HIGH: "4G",
        OPENSESSION_ENGINE_MEMORY_MAX: "nope",
        OPENSESSION_ENGINE_TASKS_MAX: "2048",
      }),
    ).toContain("--property=MemoryHigh=4G");
    expect(
      engineScopeSystemdArgs({ OPENSESSION_ENGINE_MEMORY_MAX: "nope" }),
    ).toContain("--property=MemoryMax=12G");
    expect(
      engineScopeSystemdArgs({ OPENSESSION_ENGINE_TASKS_MAX: "2048" }),
    ).toContain("--property=TasksMax=2048");
  });

  test("preview unit names are stable without exposing worktree paths", () => {
    const first = previewScopeUnit("/srv/worktrees/a");
    expect(first).toBe(previewScopeUnit("/srv/worktrees/a"));
    expect(first).not.toBe(previewScopeUnit("/srv/worktrees/b"));
    expect(first).toMatch(/^opensession-preview-[a-f0-9]{16}$/);
    expect(first).not.toContain("worktrees");
  });
});
