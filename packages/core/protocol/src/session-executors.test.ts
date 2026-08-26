import { describe, expect, test } from "bun:test";
import {
  EXECUTOR_PROVIDERS,
  isExecutorProvider,
  type ExecutionTarget,
  type ProtocolClientMessage,
} from "./session";

describe("Executor session protocol", () => {
  test("has exactly the approved providers", () => {
    expect([...EXECUTOR_PROVIDERS]).toEqual(["box", "daytona", "modal"]);
    expect(EXECUTOR_PROVIDERS.every(isExecutorProvider)).toBe(true);
    expect(isExecutorProvider("other")).toBe(false);
    expect(isExecutorProvider("local")).toBe(false);
  });

  test("distinguishes local, Runner, and managed Executor execution", () => {
    const targets: ExecutionTarget[] = [
      { kind: "local" },
      { kind: "runner", executorId: "runner-1", workspaceId: "workspace-1" },
      {
        kind: "executor",
        provider: "daytona",
        executorId: "executor-1",
        workspaceId: "workspace-1",
        lifecycle: "awake",
      },
    ];
    expect(targets.map(({ kind }) => kind)).toEqual([
      "local",
      "runner",
      "executor",
    ]);
  });

  test("keeps this machine as the create-session omission default", () => {
    const local: ProtocolClientMessage = {
      type: "create_session",
      branch: "main",
      prompt: "Inspect this repository",
      user: "person@example.com",
    };
    const remote: ProtocolClientMessage = { ...local, executor: "modal" };
    expect("executor" in local).toBe(false);
    expect(remote).toMatchObject({ executor: "modal" });
  });
});
