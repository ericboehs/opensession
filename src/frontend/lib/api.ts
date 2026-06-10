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

export async function fetchDiff(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/diff`);
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
  return res.json();
}

export async function fetchPr(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr`);
  if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
  return res.json();
}

// ── Automations ──

export async function fetchAutomations() {
  const res = await fetch(`${BASE}/automations`);
  if (!res.ok) throw new Error(`Failed to fetch automations: ${res.status}`);
  return res.json();
}

export async function createAutomationApi(input: {
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  createdBy: string;
  eventKey?: string;
}) {
  const res = await fetch(`${BASE}/automations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
  return body;
}

export async function updateAutomationApi(id: string, patch: object) {
  const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
  return body;
}

export async function deleteAutomationApi(id: string) {
  const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runAutomationApi(id: string) {
  const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
}

// ── Wiki ──

export async function fetchWikiTree() {
  const res = await fetch(`${BASE}/wiki/tree`);
  if (!res.ok) throw new Error(`Failed to fetch wiki tree: ${res.status}`);
  return res.json();
}

export async function fetchWikiFile(path: string) {
  const res = await fetch(`${BASE}/wiki/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch doc: ${res.status}`);
  return res.json();
}

export async function searchWikiApi(q: string) {
  const res = await fetch(`${BASE}/wiki/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
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
