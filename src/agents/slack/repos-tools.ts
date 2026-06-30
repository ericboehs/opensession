/**
 * michael-repos — an in-process MCP server that lets a session attach secondary
 * repos for cross-repo work. Attaching creates (or reuses) an *isolated git
 * worktree* for that repo and records it on the session, so the agent branches,
 * commits, and opens PRs there independently of the primary repo — instead of
 * editing another repo's shared main checkout (which is parked on whatever branch
 * was last used and collides with other sessions).
 *
 * Wired the same way as michael-sessions/michael-admin: interactive runs only
 * (Backstage web sessions + Slack), never automations. The handlers run in the
 * parent process and call back into backstage.ts's attachRepo via the injected
 * context, so the session file and live state update immediately.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AttachedRepo } from "../../server/types";

export interface ReposToolContext {
  /** The session these tools act on. */
  sessionId: string;
  /** Attach (or re-attach) a repo; throws with a human message on bad input. */
  attach: (project: string, branch?: string) => Promise<{ attached: AttachedRepo; all: AttachedRepo[] }>;
  /** Current repo layout for the session, or null if it can't be resolved. */
  snapshot: () => {
    primaryProject: string;
    branch: string | null;
    worktreeDir: string | null;
    attached: AttachedRepo[];
  } | null;
  /** All registered projects (id + default branch + whether shared-checkout). */
  projects: () => Array<{ id: string; defaultBranch: string; sharedCheckout: boolean }>;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createReposMcpServer(ctx: ReposToolContext) {
  const tools = [
    tool(
      "list_repos",
      "List the repos available to this session: which one is primary, which are already attached (with their worktree paths and branches), and which other projects you could attach. Use before attach_repo to see what's possible.",
      {},
      async () => {
        const snap = ctx.snapshot();
        const projects = ctx.projects();
        const lines: string[] = [];
        if (snap) {
          lines.push(`Primary: ${snap.primaryProject}${snap.branch ? ` (branch ${snap.branch})` : ""} → ${snap.worktreeDir}`);
          if (snap.attached.length) {
            lines.push("Attached:");
            for (const r of snap.attached) lines.push(`  • ${r.project} (branch ${r.branch}) → ${r.dir}`);
          } else {
            lines.push("Attached: none yet");
          }
        }
        const attachable = projects.filter(
          (p) => !p.sharedCheckout && p.id !== snap?.primaryProject
        );
        lines.push("");
        lines.push("Attachable projects: " + attachable.map((p) => p.id).join(", "));
        return text(lines.join("\n"));
      }
    ),
    tool(
      "attach_repo",
      "Attach a secondary repo to this session so you can work in it cross-repo. Creates (or reuses) an ISOLATED git worktree for that repo and returns its path — work there, then commit/push and open a PR in that repo independently. Prefer this over cd-ing into a repo's main checkout. Branch defaults to this session's branch.",
      {
        project: z
          .string()
          .describe("Project id to attach (e.g. 'gitops', 'infra', 'shared-infra', 'gstreamer', 'gst-plugins-rs'). See list_repos."),
        branch: z
          .string()
          .optional()
          .describe("Branch to check out in the worktree. Defaults to this session's primary branch."),
      },
      async (args: { project: string; branch?: string }) => {
        try {
          const { attached, all } = await ctx.attach(args.project, args.branch);
          const others = all.filter((r) => r.project !== attached.project);
          return text(
            `Attached ${attached.project} on branch ${attached.branch}.\n` +
              `Worktree: ${attached.dir}\n` +
              `cd there to work in it; commit/push and open a PR in this repo independently of the primary repo.` +
              (others.length ? `\n(Also attached: ${others.map((r) => r.project).join(", ")}.)` : "")
          );
        } catch (e: any) {
          return text(`Couldn't attach ${args.project}: ${e?.message || String(e)}`);
        }
      }
    ),
  ];

  return createSdkMcpServer({ name: "michael-repos", version: "1.0.0", tools });
}
