import { describe, expect, test } from "bun:test";
import {
  hasWorkspaceGroup,
  inWorkspaceGroup,
  isolatedWorktree,
} from "./workspace-group";

const WT = "/home/ubuntu/worktrees/tella-fusion-codex/rehome-setup-controls";
const SHARED = "/home/ubuntu/projects/opensession";

describe("isolatedWorktree", () => {
  test("an isolated worktree identifies one piece of work", () => {
    expect(isolatedWorktree(WT)).toBe(WT);
  });

  test("a shared checkout does not", () => {
    // Every session in the self-hosted repo sits here, so matching on it
    // would sweep the whole repo into one workspace's history.
    expect(isolatedWorktree(SHARED)).toBeNull();
    expect(isolatedWorktree(undefined)).toBeNull();
    expect(isolatedWorktree(null)).toBeNull();
  });
});

describe("inWorkspaceGroup", () => {
  test("the workspace id is enough", () => {
    expect(
      inWorkspaceGroup({ workspaceId: "ws-1" }, { workspaceId: "ws-1" }),
    ).toBe(true);
    expect(
      inWorkspaceGroup({ workspaceId: "ws-2" }, { workspaceId: "ws-1" }),
    ).toBe(false);
  });

  test("a duplicate workspace record is adopted through the shared worktree", () => {
    // A branch can carry two workspaces: the one a person made and the
    // `ghpr-` one the PR agent minted. Its sessions still belong here.
    expect(
      inWorkspaceGroup(
        { workspaceId: "ws-ghpr", worktreeDir: WT },
        { workspaceId: "ws-mine", worktreeDir: WT },
      ),
    ).toBe(true);
  });

  test("a shared checkout never groups", () => {
    expect(
      inWorkspaceGroup(
        { workspaceId: "ws-other", worktreeDir: SHARED },
        { workspaceId: "ws-mine", worktreeDir: SHARED },
      ),
    ).toBe(false);
  });

  test("a workspace-less session groups by its worktree alone", () => {
    expect(inWorkspaceGroup({ worktreeDir: WT }, { worktreeDir: WT })).toBe(
      true,
    );
  });
});

describe("hasWorkspaceGroup", () => {
  test("an id or an isolated worktree is groupable", () => {
    expect(hasWorkspaceGroup({ workspaceId: "ws-1" })).toBe(true);
    expect(hasWorkspaceGroup({ worktreeDir: WT })).toBe(true);
  });

  test("a lone session in a shared checkout is not", () => {
    expect(hasWorkspaceGroup({ worktreeDir: SHARED })).toBe(false);
    expect(hasWorkspaceGroup({})).toBe(false);
  });
});
