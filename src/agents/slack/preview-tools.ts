/**
 * michael-preview — a tiny in-process MCP server that lets a session record
 * *where* its change should be tested. The path is stored on the session and
 * appended to the Preview (local dev server) and Staging (Vercel PR deploy)
 * links in the session viewer, so a human clicks one button and lands directly
 * on the feature under test (e.g. the tag editor) instead of the app root.
 *
 * Wired the same way as michael-repos: interactive runs only (Backstage web
 * sessions + Slack), never automations, and only when a sessionId is in scope.
 * The handler runs in the parent process and persists via the injected
 * setPreviewPath callback (touchBackstageSession), so the buttons update live.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface PreviewToolContext {
  /** The session these tools act on. */
  sessionId: string;
  /** Persist the deep-link path (null/empty clears it). */
  setPreviewPath: (path: string | null) => void;
  /** Current stored path, or null. */
  current: () => string | null;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/**
 * Normalize whatever the agent passes into a root-relative path.
 * - A full URL (it sometimes pastes the whole preview URL) → keep only
 *   pathname + query + hash.
 * - A bare route → ensure a single leading slash.
 * - Empty / whitespace → null (clears the deep link).
 */
function normalizePath(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const rest = u.pathname + u.search + u.hash;
      return rest === "/" ? null : rest;
    } catch {
      // fall through to the bare-path handling
    }
  }
  return "/" + s.replace(/^\/+/, "");
}

export function createPreviewMcpServer(ctx: PreviewToolContext) {
  const tools = [
    tool(
      "set_preview_path",
      "Set the route where this session's change should be tested, so the human's Preview and Staging buttons open directly on that feature instead of the app root. Call this once you know which page exercises your change (e.g. a specific editor route). Pass a root-relative path like `/edit/abc123` or `/settings/tags`; the same path is appended to both the local Preview URL and the PR's Staging deploy. Pass an empty string to clear it.",
      {
        path: z
          .string()
          .describe(
            "Root-relative path to deep-link to (e.g. `/edit/abc123`). A full URL is accepted (only its path/query is kept). Empty string clears the deep link.",
          ),
      },
      async (args: { path: string }) => {
        const path = normalizePath(args.path);
        ctx.setPreviewPath(path);
        return text(
          path
            ? `Preview & Staging buttons will now open ${path}.`
            : "Cleared the preview deep link — the buttons open the app root again.",
        );
      },
    ),
  ];

  return createSdkMcpServer({ name: "michael-preview", version: "1.0.0", tools });
}
