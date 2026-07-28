/**
 * Tella Public API client (https://www.tella.com/docs/introduction.md).
 * Read-only for now: the sidebar feed lists the key owner's recent videos.
 * Auth is a Bearer API key (`tella_pk_…`) from TELLA_API_KEY — absent key =
 * Tella not configured, the feed simply doesn't register.
 */

const TELLA_API = "https://api.tella.com/v1";

export interface TellaVideo {
  id: string;
  name: string;
  description: string | null;
  views: number;
  aspectRatio: string;
  dimensions: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  links: { viewPage: string; embedPage: string };
}

export function tellaConfigured(): boolean {
  return !!process.env.TELLA_API_KEY;
}

export async function listRecentVideos(limit = 30): Promise<TellaVideo[]> {
  const key = process.env.TELLA_API_KEY;
  if (!key) throw new Error("TELLA_API_KEY not configured");
  const res = await fetch(`${TELLA_API}/videos?limit=${limit}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`Tella videos list failed: ${res.status} ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { videos?: TellaVideo[] };
  return body.videos || [];
}

/** The in-app editor page for a video (not part of the API's links object). */
export function tellaEditUrl(videoId: string): string {
  return `https://www.tella.tv/video/${videoId}/edit`;
}

export interface TellaVideoDetail extends TellaVideo {
  durationSeconds?: number;
  chapters?: { title: string; description?: string; startTime?: number }[];
  transcript?: { status: string; language?: string; text?: string } | null;
}

/** One video with chapters + transcript (GET /v1/videos/:id). */
export async function getVideo(id: string): Promise<TellaVideoDetail | null> {
  const key = process.env.TELLA_API_KEY;
  if (!key) return null;
  const res = await fetch(`${TELLA_API}/videos/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { video?: TellaVideoDetail };
  return body.video || null;
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
  const text = v.transcript?.status === "ready" ? v.transcript.text || "" : "";
  if (text) {
    const excerpt = text.slice(0, TRANSCRIPT_EXCERPT_CHARS);
    lines.push(
      `Transcript${text.length > excerpt.length ? ` (first ${TRANSCRIPT_EXCERPT_CHARS} chars — fetch the rest via the API if needed)` : ""}:`,
      excerpt,
    );
  }
  return lines.join("\n");
}
