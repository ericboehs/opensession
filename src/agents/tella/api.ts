/**
 * Tella access for server-side features (sidebar feed, opening-prompt video
 * context) — via the SAME Tella MCP server sessions use
 * (https://api.tella.com/mcp, OAuth grants from Settings → My accounts /
 * Connections), never a parallel REST client with an API key. Calls run on
 * the requesting user's grant, falling back to the workspace grant
 * (src/server/mcp-client.ts + mcp-oauth.ts).
 */
import { callMcpTool } from "../../server/mcp-client";
import { readMcpConfig } from "../../server/connections";
import { hasMcpOauthGrant } from "../../server/mcp-oauth";

export interface TellaVideo {
  id: string;
  name: string;
  description: string | null;
  views: number;
  aspectRatio: string;
  createdAt: string;
  updatedAt: string;
  links: { viewPage: string; embedPage: string };
}

/** The tella MCP server exists in config and someone has connected it. */
export function tellaConfigured(): boolean {
  // The integration registry marks this module `always: true`, which means it
  // loads regardless of config and "self-gates internally" — so this function
  // is where its enable flag has to be honored; the loader never consults it.
  // Explicit opt-out only: an unset flag falls through to the grant check, so
  // this can't silently disable the feed the way a truthy-check would.
  if (process.env.ENABLE_TELLA_MODULE === "false") return false;
  return !!readMcpConfig().mcpServers.tella && hasMcpOauthGrant("tella");
}

/** Recent videos visible to `user`'s Tella account (workspace grant fallback). */
export async function listRecentVideos(
  limit = 30,
  user?: string,
  extraArgs?: Record<string, string>,
): Promise<TellaVideo[]> {
  const body = await callMcpTool<{ videos?: TellaVideo[] }>(
    "tella",
    "list_videos",
    { limit, ...(extraArgs || {}) },
    user,
  );
  return body.videos || [];
}

/** The in-app editor page for a video (not part of the links object). */
export function tellaEditUrl(videoId: string): string {
  return `https://www.tella.tv/video/${videoId}/edit`;
}

export interface TellaVideoDetail extends TellaVideo {
  durationSeconds?: number;
  chapters?: { title: string; description?: string; startTime?: number }[];
  transcript?: { status: string; language?: string; text?: string } | null;
}

/** One video with chapters + transcript, on `user`'s grant. */
export async function getVideo(
  id: string,
  user?: string,
): Promise<TellaVideoDetail | null> {
  try {
    const body = await callMcpTool<{ video?: TellaVideoDetail }>(
      "tella",
      "get_video",
      { id, includeTranscript: true, includeChapters: true },
      user,
    );
    return body.video || null;
  } catch {
    return null;
  }
}

const TRANSCRIPT_EXCERPT_CHARS = 8_000;

/** Video context for a session's opening prompt (the Plain ticket-context
 *  analogue): metadata + chapters + a transcript excerpt. */
export function formatVideoContext(v: TellaVideoDetail): string {
  const mins = v.durationSeconds
    ? `${Math.round(v.durationSeconds / 60)} min`
    : null;
  const lines = [
    `Title: ${v.name}`,
    ...(v.description ? [`Description: ${v.description}`] : []),
    ...(mins ? [`Duration: ${mins}`] : []),
    `Created: ${v.createdAt} · Views: ${v.views}`,
    `View page: ${v.links?.viewPage} · Editor: ${tellaEditUrl(v.id)}`,
  ];
  if (v.chapters?.length) {
    lines.push(
      "Chapters:",
      ...v.chapters.map(
        (c) => `- ${c.title}${c.description ? ` — ${c.description}` : ""}`,
      ),
    );
  }
  const text =
    typeof v.transcript === "string"
      ? v.transcript
      : v.transcript?.status === "ready"
        ? v.transcript.text || ""
        : "";
  if (text) {
    const excerpt = text.slice(0, TRANSCRIPT_EXCERPT_CHARS);
    lines.push(
      `Transcript${text.length > excerpt.length ? ` (first ${TRANSCRIPT_EXCERPT_CHARS} chars — fetch the rest via the tella MCP get_transcript tool if needed)` : ""}:`,
      excerpt,
    );
  }
  return lines.join("\n");
}
