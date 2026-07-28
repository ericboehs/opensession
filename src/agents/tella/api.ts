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
