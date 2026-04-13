import type { UnifiedSession } from "./types";

const BASE = "/backstage/api";

export async function fetchSessions(): Promise<UnifiedSession[]> {
  const res = await fetch(`${BASE}/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

export async function fetchTranscript(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/transcript`);
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return res.json();
}

export async function fetchWorktrees() {
  const res = await fetch(`${BASE}/worktrees`);
  if (!res.ok) throw new Error(`Failed to fetch worktrees: ${res.status}`);
  return res.json();
}

export async function deleteSessionApi(sessionId: string, cleanWorktree: boolean): Promise<void> {
  const params = cleanWorktree ? "?worktree=true" : "";
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}${params}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete: ${res.status}`);
  }
}

export function getWebSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/backstage/ws`;
}

export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
