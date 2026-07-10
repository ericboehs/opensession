/**
 * opensession-walkthrough — publish a Cursor-style PR walkthrough for this
 * session: a short demo video + before/after screenshots + a writeup. Stored
 * on the session (rendered inline in the Review tab) and mirrored into the
 * GitHub PR description as a managed section (media as tailnet links there —
 * see src/server/walkthrough.ts for why they can't inline on GitHub).
 *
 * Wired like opensession-preview: interactive runs only (web sessions +
 * Slack), never automations, and only when a sessionId is in scope.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { publishWalkthrough } from "../../server/walkthrough";

export interface WalkthroughToolContext {
  sessionId: string;
  /** Attribution for publishedBy (the run's user). */
  by?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createWalkthroughMcpServer(ctx: WalkthroughToolContext) {
  const tools = [
    tool(
      "publish_walkthrough",
      "Publish a walkthrough of this session's change: a demo video, before/after screenshots, and a short writeup. It renders inline in the session's Review tab and is mirrored into the GitHub PR description (managed section — republishing replaces it, so publish again after the PR exists or when the change evolves). Record the video / screenshots first (e.g. the tella-local skill), pass absolute file paths; files are copied to durable storage, so temp paths are fine. Summary: 2-6 sentences of markdown — what changed and how it was verified (root cause for fixes).",
      {
        summary: z
          .string()
          .describe(
            "Markdown writeup: what changed, root cause (for fixes), how it was verified. Shown under the video and in the PR body.",
          ),
        video: z
          .string()
          .optional()
          .describe(
            "Absolute path to a short screen-recording demoing the change AFTER the fix (mp4/webm/mov).",
          ),
        video_title: z
          .string()
          .optional()
          .describe('Short human title for the video, e.g. "Model picker alignment — after".'),
        shots: z
          .array(
            z.object({
              before: z.string().optional().describe("Absolute path to the BEFORE screenshot (png/jpg/webp/gif)."),
              after: z.string().optional().describe("Absolute path to the AFTER screenshot."),
              caption: z.string().optional().describe("What this pair shows, one short phrase."),
            }),
          )
          .optional()
          .describe("Before/after screenshot pairs (either side may be omitted)."),
      },
      async (args: {
        summary: string;
        video?: string;
        video_title?: string;
        shots?: Array<{ before?: string; after?: string; caption?: string }>;
      }) => {
        try {
          const { walkthrough, pr } = await publishWalkthrough(
            ctx.sessionId,
            {
              summary: args.summary,
              video: args.video,
              videoTitle: args.video_title,
              shots: args.shots,
            },
            ctx.by,
          );
          const parts = [
            `Walkthrough published — it now shows in this session's Review tab (${walkthrough.video ? "video, " : ""}${walkthrough.shots?.length ? `${walkthrough.shots.length} before/after pair(s), ` : ""}writeup).`,
          ];
          if (pr.mirrored) parts.push(`Mirrored into the PR description: ${pr.url}`);
          else
            parts.push(
              `Not yet on a PR (${pr.reason}). Call publish_walkthrough again after opening the PR and it will be spliced into the description.`,
            );
          return text(parts.join(" "));
        } catch (e: any) {
          return text(`publish_walkthrough failed: ${e?.message || String(e)}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-walkthrough",
    version: "1.0.0",
    tools,
  });
}
