/**
 * opensession-preflight — an in-process MCP server that lets a session run the
 * SAME review its PR would get, locally, BEFORE `gh pr create` (preflight.ts).
 * The reviewer runs fresh-context and cross-family (model inversion) in the
 * session's own worktree; findings return to the caller to fix, cutting the
 * review → handoff → autofix → re-review GitHub round-trips.
 *
 * Wired like the other siblings: interactive runs only (Backstage web sessions
 * + loops), never automations — the run-rpc fallback builder fails closed for
 * automation-owned sessions. Read-only: it inspects the worktree and spawns an
 * ask-mode reviewer; it changes nothing and posts nothing.
 */
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";

export interface PreflightToolContext {
  /** The authoring session these tools act on. */
  sessionId: string;
  /** Current session shape, resolved fresh per call. */
  snapshot: () => {
    worktreeDir: string | null;
    branch: string | null;
    model?: string;
    projectId?: string | null;
    title?: string;
  } | null;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createPreflightMcpServer(ctx: PreflightToolContext) {
  const tools = [
    tool(
      "preflight_review",
      "Run the automated code review on this session's branch NOW, before opening a PR — the same review (same prompt, same bar, cross-model-family reviewer) the PR would get on GitHub, minus the round-trip. Returns verdict + findings for you to fix in this session. Call it when the work is done and you're about to `gh pr create`; fix the P0/P1s (and any P2/P3 you accept), then open the PR — the normal PR review still runs there and should come back clean. Blocks for a few minutes while the reviewer works. Skip for trivial or docs-only changes.",
      {
        focus: z
          .string()
          .optional()
          .describe(
            "Optional steer for the reviewer — a specific file, change, or concern to prioritize.",
          ),
      },
      async (args: { focus?: string }) => {
        const snap = ctx.snapshot();
        if (!snap?.worktreeDir || !snap.branch) {
          return text(
            "This session has no worktree/branch to review — pre-flight review only works in a code-mode session with a checkout.",
          );
        }
        try {
          const { runPreflightReview } = await import("../github/preflight");
          const res = await runPreflightReview({
            sessionId: ctx.sessionId,
            cwd: snap.worktreeDir,
            branch: snap.branch,
            sessionModel: snap.model,
            projectId: snap.projectId,
            sessionTitle: snap.title,
            focus: args.focus,
          });
          const next = res.error
            ? "\n\nThe review errored — you can retry once, or just open the PR and let the normal PR review run."
            : res.blocking > 0
              ? "\n\nFix the P0/P1 findings above (and any others you accept) before `gh pr create`. If you disagree with a finding, leave the code as-is and note why in the PR description — don't silently drop it."
              : "\n\nAddress anything you accept, then open the PR.";
          return text(res.markdown + next);
        } catch (e: any) {
          return text(`Pre-flight review failed: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-preflight", version: "1.0.0", tools });
}
