import { describe, expect, test } from "bun:test";
import { resolvePreviewBoot } from "./preview";

// The resolver is the ONE bring-up chain shared by host and sandbox previews:
// repo-committed .backstage/start.sh → configured previewCommand → tella-local
// fallback (tella-fusion only). `exists` abstracts host-fs vs in-container
// checks, so these tests drive it with plain sets of paths.

const WT = "/home/ubuntu/worktrees/tella-fusion-some-branch";
const ENSURE_UP = "/home/ubuntu/.claude/skills/tella-local/ensure-up.sh";

function existsIn(paths: string[]) {
  return (p: string) => paths.includes(p);
}

describe("resolvePreviewBoot", () => {
  test("repo-committed .backstage/start.sh wins over previewCommand", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "tella-fusion", previewCommand: ENSURE_UP },
      existsIn([`${WT}/.backstage/start.sh`, ENSURE_UP]),
    );
    expect(boot).toEqual({
      kind: "repo-script",
      cmd: `bash ${WT}/.backstage/start.sh`,
      setupScript: undefined,
    });
  });

  test("start.sh resolution picks up the sibling setup.sh one-shot hook", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "tella-fusion" },
      existsIn([`${WT}/.backstage/start.sh`, `${WT}/.backstage/setup.sh`]),
    );
    expect(boot?.kind).toBe("repo-script");
    expect(boot?.setupScript).toBe(`${WT}/.backstage/setup.sh`);
  });

  test("previewCommand runs with the worktree as $1", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "tella-fusion", previewCommand: ENSURE_UP },
      existsIn([ENSURE_UP]),
    );
    expect(boot).toEqual({ kind: "preview-command", cmd: `${ENSURE_UP} ${WT}` });
  });

  test("non-absolute previewCommand is trusted without an existence check", async () => {
    const boot = await resolvePreviewBoot(
      "/home/ubuntu/worktrees/gitops-some-branch",
      { id: "gitops", previewCommand: "npm run dev --" },
      existsIn([]),
    );
    expect(boot).toEqual({
      kind: "preview-command",
      cmd: "npm run dev -- /home/ubuntu/worktrees/gitops-some-branch",
    });
  });

  test("missing absolute previewCommand falls through to tella-local (tella-fusion)", async () => {
    const boot = await resolvePreviewBoot(
      WT,
      { id: "tella-fusion", previewCommand: "/nonexistent/bring-up.sh" },
      existsIn([ENSURE_UP]),
    );
    expect(boot?.kind).toBe("tella-local");
    expect(boot?.cmd).toBe(`bash ${ENSURE_UP} ${WT}`);
  });

  test("tella-local fallback is tella-fusion-only", async () => {
    const boot = await resolvePreviewBoot(
      "/home/ubuntu/worktrees/gitops-some-branch",
      { id: "gitops" },
      existsIn([ENSURE_UP]),
    );
    expect(boot).toBeNull();
  });

  test("no mechanism at all resolves to null (UI: disabled Start)", async () => {
    const boot = await resolvePreviewBoot(WT, { id: "tella-fusion" }, existsIn([]));
    expect(boot).toBeNull();
  });
});
