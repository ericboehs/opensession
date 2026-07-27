/**
 * opensession-preview — a tiny in-process MCP server that lets a session record
 * *where* its change should be tested. The path is stored on the session and
 * appended to the Preview (local dev server) and Staging (Vercel PR deploy)
 * links in the session viewer, so a human clicks one button and lands directly
 * on the feature under test (e.g. the tag editor) instead of the app root.
 *
 * Wired the same way as opensession-repos: interactive runs only (Backstage web
 * sessions + Slack), never automations, and only when a sessionId is in scope.
 * The handler runs in the parent process and persists via the injected
 * setPreviewPath callback (touchBackstageSession), so the buttons update live.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";

export interface PreviewToolContext {
  /** The session these tools act on. */
  sessionId: string;
  /** Persist the deep-link path (null/empty clears it). */
  setPreviewPath: (path: string | null) => void;
  /** Current stored path, or null. */
  current: () => string | null;
  /** Start (or claim from the warm pool) the session's dev-server preview. */
  start: () => Promise<PreviewLifecycleStatus>;
  /** Current preview status (running/starting + URL when live). */
  status: () => Promise<PreviewLifecycleStatus>;
  /** Stop the preview (releases a pool container / kills the host boot). */
  stop: () => Promise<PreviewLifecycleStatus>;
}

export interface PreviewLifecycleStatus {
  running: boolean;
  starting: boolean;
  previewUrl: string | null;
  /** Whether a boot path exists for this worktree at all (undefined = unknown). */
  bootable?: boolean;
}

function describeStatus(s: PreviewLifecycleStatus): string {
  if (s.running && s.previewUrl) {
    return [
      `Preview is RUNNING at ${s.previewUrl}`,
      "",
      "To look at it yourself, drive a headless Chrome over CDP:",
      "  1. `~/bin/cdp-chrome` — starts (or reuses) a detached headless Chrome and prints its CDP port; it self-terminates when idle.",
      `  2. Open the page, e.g.: \`bunx playwright screenshot --browser chromium ${s.previewUrl} shot.png\` or connect Playwright/Puppeteer to the printed CDP port for clicks, evals and screenshots.`,
      "The URL serves this session's code (worktree edits sync in live — give big changes a few seconds to recompile).",
    ].join("\n");
  }
  if (s.starting) {
    return "Preview is STARTING — a dev server is booting (warm pool claims serve in seconds; a cold host boot can take ~1 min; a big branch flip reboots the dev server, ~1 min). Poll preview_status until it reports running.";
  }
  return "Preview is NOT running. Call start_preview to bring it up.";
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
      "Set the route where this session's change should be tested, so the human's local Preview and Preview environment buttons open directly on that feature instead of the app root. Call this once you know which page exercises your change (e.g. a specific editor route). Pass a root-relative path like `/edit/abc123` or `/settings/tags`; the same path is appended to both the local Preview URL and the PR's preview environment. Pass an empty string to clear it.",
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
            ? `Local Preview and Preview environment buttons will now open ${path}.`
            : "Cleared the preview deep link — the buttons open the app root again.",
        );
      },
    ),
    tool(
      "start_preview",
      "Start this session's dev-server preview (the same thing the human's Preview button does): a warm pre-booted container is claimed when available (serves in seconds) or a dev server boots for the worktree. Returns the preview URL once running — use it to verify your change in the real app, including headlessly via Chrome CDP. Combine with set_preview_path so humans land on the feature under test.",
      {},
      async () => {
        try {
          const s = await ctx.start();
          // A start that comes back neither running nor starting FAILED — the
          // generic "call start_preview" status text here sent agents in a
          // loop calling start_preview from start_preview (papercut 2026-07-27).
          if (!s.running && !s.starting) {
            return text(
              s.bootable === false
                ? "Preview can't start: this worktree has no preview boot path (no repo start script or configured preview command). Don't retry start_preview — verify another way (e.g. run the app yourself)."
                : "Preview didn't start: no warm pool container was available and the host boot didn't kick off (port allocation or boot resolution failed). Check preview_status once; if it's still down, don't loop on start_preview — investigate or verify another way.",
            );
          }
          return text(describeStatus(s));
        } catch (e) {
          return text(`Failed to start the preview: ${(e as Error)?.message || e}`);
        }
      },
    ),
    tool(
      "preview_status",
      "Check whether this session's preview is running, starting, or stopped — and get its URL when live. Poll this after start_preview until it reports running.",
      {},
      async () => {
        try {
          return text(describeStatus(await ctx.status()));
        } catch (e) {
          return text(`Failed to read preview status: ${(e as Error)?.message || e}`);
        }
      },
    ),
    tool(
      "stop_preview",
      "Stop this session's preview: releases the warm pool container (or kills the host dev server). Do this when you're done verifying — it frees the pool for other sessions.",
      {},
      async () => {
        try {
          return text(
            (await ctx.stop()).running
              ? "Stop was requested but something still reports running — check preview_status again."
              : "Preview stopped.",
          );
        } catch (e) {
          return text(`Failed to stop the preview: ${(e as Error)?.message || e}`);
        }
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-preview", version: "1.0.0", tools });
}
