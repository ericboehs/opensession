import { expect, test } from "bun:test";
import {
  canonicalToolName,
  parseMcpTool,
  toolFamily,
  toolLineStats,
  toolSummary,
} from "./ToolCallBlock";

const roots = [
  { dir: "/home/ubuntu/projects/tella-backstage" },
  { dir: "/home/ubuntu/worktrees/fusion-x", label: "tella-fusion" },
];

// The engine emits lowercase ids with camelCase inputs; transcripts from the
// Claude-SDK era use "Read"/"file_path". Both have to render the same.
test("opencode and Claude-SDK file reads summarize identically", () => {
  const path = "/home/ubuntu/projects/tella-backstage/package.json";
  expect(toolSummary("read", { filePath: path, limit: 40 }, "Using read", roots)).toBe(
    "package.json"
  );
  expect(toolSummary("Read", { file_path: path }, "Using Read", roots)).toBe("package.json");
  expect(toolFamily("read")).toBe("file");
  expect(canonicalToolName("read")).toBe("Read");
});

test("paths render relative to the session's worktrees", () => {
  expect(
    toolSummary("read", { filePath: "/home/ubuntu/worktrees/fusion-x/src/App.res" }, "", roots)
  ).toBe("tella-fusion:src/App.res");
  // Outside every worktree, only $HOME collapses.
  expect(toolSummary("read", { filePath: "/home/ubuntu/notes.md" }, "", roots)).toBe("~/notes.md");
  expect(toolSummary("read", { filePath: "/etc/hosts" }, "", roots)).toBe("/etc/hosts");
  // No roots (evidence pane, previews outside a session) — absolute, tidied.
  expect(toolSummary("read", { filePath: "/home/ubuntu/projects/x/a.ts" }, "")).toBe(
    "~/projects/x/a.ts"
  );
});

test("bash, grep and glob summaries drop their plumbing", () => {
  expect(
    toolSummary("bash", { command: "ls -la", workdir: "/tmp", timeout: 5 }, "", roots)
  ).toBe("ls -la");
  expect(toolSummary("exec_command", { cmd: "git status" }, "", roots)).toBe("git status");
  expect(
    toolSummary(
      "grep",
      { pattern: "foo", path: "/home/ubuntu/projects/tella-backstage/src", include: "*.ts" },
      "",
      roots
    )
  ).toBe("/foo/ src");
  // A glob with no path used to render a stray trailing space.
  expect(toolSummary("glob", { pattern: "**/*.tsx" }, "", roots)).toBe("**/*.tsx");
});

test("codex patch bodies name the files they touch", () => {
  const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** Add File: src/b.ts\n+y\n";
  expect(toolSummary("apply_patch", { patchText }, "Using apply_patch", roots)).toBe(
    "src/a.ts  ·  src/b.ts"
  );
  expect(toolFamily("apply_patch")).toBe("edit");
  expect(toolLineStats("apply_patch", { patchText })).toEqual({
    additions: 2,
    deletions: 0,
  });
});

test("edit rows report added and removed lines", () => {
  expect(
    toolLineStats("edit", {
      oldString: "one\ntwo\nthree",
      newString: "one\nupdated\nthree\nfour\nfive",
    })
  ).toEqual({ additions: 5, deletions: 3 });

  expect(
    toolLineStats("multiedit", {
      edits: [
        { old_string: "old", new_string: "new\nextra" },
        { old_string: "remove", new_string: "replace" },
      ],
    })
  ).toEqual({ additions: 3, deletions: 2 });
});

test("todo writes summarize as progress, not raw JSON", () => {
  expect(
    toolSummary(
      "todowrite",
      {
        todos: [
          { content: "one", status: "completed" },
          { content: "two", status: "in_progress" },
          { content: "three", status: "pending" },
        ],
      },
      "",
      roots
    )
  ).toBe("two  ·  1/3 done");
});

test("MCP tools parse in both the mcp__ and flattened forms", () => {
  expect(parseMcpTool("mcp__linear__list_issues")).toEqual({
    server: "linear",
    tool: "list_issues",
  });
  expect(parseMcpTool("grafana_query_loki_logs")).toEqual({
    server: "grafana",
    tool: "query_loki_logs",
  });
  expect(parseMcpTool("opensession-sessions_get_session")).toEqual({
    server: "opensession-sessions",
    tool: "get_session",
  });
  // Native tools that happen to contain an underscore are not MCP calls.
  expect(parseMcpTool("apply_patch")).toBeNull();
  expect(parseMcpTool("exec_command")).toBeNull();
  expect(parseMcpTool("read")).toBeNull();
});

test("the run-rpc session key stays out of MCP summaries", () => {
  expect(
    toolSummary(
      "opensession-sessions_get_session",
      { __bks_oc_session: "ses_123", id: "bks-1" },
      "",
      roots
    )
  ).toBe("id: bks-1");
});
