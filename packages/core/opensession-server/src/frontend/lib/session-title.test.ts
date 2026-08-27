import { describe, expect, test } from "bun:test";
import { sessionReferenceTitle } from "./session-title";

describe("sessionReferenceTitle", () => {
  test("uses a worker's delegated task title instead of its parent's workspace", () => {
    expect(
      sessionReferenceTitle({
        title: "Implement Pi agent-operation adapter",
        workspaceName: "Turn sandboxes into orbs",
        parentSessionId: "os-parent",
      }),
    ).toBe("Implement Pi agent-operation adapter");
  });

  test("keeps the workspace label for a human session", () => {
    expect(
      sessionReferenceTitle({
        title: "Investigate the architecture",
        workspaceName: "Turn sandboxes into orbs",
      }),
    ).toBe("Turn sandboxes into orbs");
  });

  test("falls back to the session title without a workspace name", () => {
    expect(sessionReferenceTitle({ title: "Standalone task" })).toBe(
      "Standalone task",
    );
  });
});
