/**
 * opensession-assets — an in-process MCP server giving a session a scratch
 * assets folder (~/.opensession-assets/<sessionId>/) it can save previewable
 * artifacts into: interactive HTML/JS visualizations, generated reports,
 * diagrams, sample data. Files are NOT part of any repo and never get
 * committed; the session viewer's Assets tab shows a live file tree + preview
 * (HTML renders in an iframe, relative references between assets work).
 *
 * The handlers run in the parent process, so this works identically for
 * read-only Ask sessions (whose permission config blocks file writes in the
 * checkout — the assets folder is deliberately exempt scratch space) and for
 * sandboxed sessions (whose worktree isn't even on this host).
 *
 * Wired like the other siblings: interactive runs only (Open Session web
 * sessions + Slack), never automations.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import {
  assetsDirFor,
  deleteAssetAcross,
  findAssetPath,
  listAssetsAcross,
  writeAsset,
  MAX_WRITE_BYTES,
} from "../../server/session-assets";
import { sessionIdsFor } from "../../server/session-cache";
import { readFileSync, statSync } from "fs";

const READ_CAP = 256 * 1024;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function createAssetsMcpServer(ctx: { sessionId: string }) {
  const assetSessionIds = () => sessionIdsFor(ctx.sessionId);
  const tools = [
    tool(
      "write_asset",
      "Save a file into this session's assets folder — scratch space for helper artifacts the human can preview in the session's Assets tab or open directly from its path in chat: interactive HTML/JS visualizations, generated reports, diagrams, sample data. Add a short description so the viewer explains what the asset shows. Assets are NOT part of any repo and are never committed (if something turns out PR-worthy, copy it into the worktree explicitly). HTML previews live in the UI and relative references between assets resolve, so multi-file pages (index.html + style.css + data.json) work. Overwrites silently — iterating on the same file is the normal flow. Works in read-only Ask sessions too: the assets folder is session scratch, not the checkout.",
      {
        path: z
          .string()
          .describe(
            "Relative path inside the assets folder, e.g. 'report.html' or 'viz/index.html'. Subfolders are created automatically."
          ),
        content: z.string().describe("The file content (UTF-8 text, or base64 with encoding: 'base64')."),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("A short human-facing explanation of what the asset shows or why it is useful."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How `content` is encoded. Default utf8; use base64 for binary files (images, pdf)."),
      },
      async (args: { path: string; content: string; description?: string; encoding?: "utf8" | "base64" }) => {
        try {
          const sessionId = assetSessionIds()[0] || ctx.sessionId;
          const data = Buffer.from(
            args.content,
            args.encoding === "base64" ? "base64" : "utf8"
          );
          const f = writeAsset(sessionId, args.path, data, args.description);
          return text(
            `Saved ${f.path} (${fmtSize(f.size)}). It's visible in this session's Assets tab now.\n` +
              `Reference \`${f.path}\` in chat to give the reader a direct open link.\n` +
              `On disk: ${assetsDirFor(sessionId)}/${f.path}`
          );
        } catch (e: any) {
          return text(`Couldn't write ${args.path}: ${e?.message || String(e)}`);
        }
      }
    ),
    tool(
      "list_assets",
      "List this session's assets folder (path, size, modified time), plus its on-disk location. In code mode you can also write into that directory directly with shell tools — useful for binary files or anything over the write_asset size cap.",
      {},
      async () => {
        const sessionIds = assetSessionIds();
        const dir = assetsDirFor(sessionIds[0] || ctx.sessionId);
        const files = listAssetsAcross(sessionIds);
        if (!files.length)
          return text(
            `No assets yet. Save files with write_asset (or directly into ${dir}); ` +
              `they show up in the session's Assets tab with a live preview.`
          );
        const lines = files.map(
          (f) => `  ${f.path}  (${fmtSize(f.size)})${f.description ? ` — ${f.description}` : ""}`
        );
        return text(
          `Assets dir: ${dir} (write_asset cap ${fmtSize(MAX_WRITE_BYTES)}/file)\n${lines.join("\n")}`
        );
      }
    ),
    tool(
      "read_asset",
      "Read back a text asset from this session's assets folder (capped at 256 KB).",
      {
        path: z.string().describe("Relative path inside the assets folder."),
      },
      async (args: { path: string }) => {
        try {
          const found = findAssetPath(assetSessionIds(), args.path);
          if (!found) throw new Error(`no such asset: ${args.path}`);
          const { abs, rel } = found;
          const size = statSync(abs).size;
          const buf = readFileSync(abs);
          const body = buf.subarray(0, READ_CAP).toString("utf8");
          return text(
            size > READ_CAP
              ? `${rel} (${fmtSize(size)}, first ${fmtSize(READ_CAP)} shown):\n${body}`
              : `${rel} (${fmtSize(size)}):\n${body}`
          );
        } catch (e: any) {
          return text(`Couldn't read ${args.path}: ${e?.message || String(e)}`);
        }
      }
    ),
    tool(
      "delete_asset",
      "Delete a file (or a whole subfolder) from this session's assets folder.",
      {
        path: z.string().describe("Relative path inside the assets folder."),
      },
      async (args: { path: string }) => {
        try {
          deleteAssetAcross(assetSessionIds(), args.path);
          return text(`Deleted ${args.path}.`);
        } catch (e: any) {
          return text(`Couldn't delete ${args.path}: ${e?.message || String(e)}`);
        }
      }
    ),
  ];

  return createSdkMcpServer({ name: "opensession-assets", version: "1.0.0", tools });
}
