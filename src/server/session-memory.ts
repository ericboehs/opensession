/**
 * Session-scoped memory for OpenSession runs — repo / user / team scopes,
 * generalizing the Slack channel memory (src/agents/slack/memory.ts) and
 * sharing its store (~/.michael-memory) so facts flow both ways:
 *
 *   - team           -> the SAME `workspace` store that Slack public-channel
 *                       memory writes to: a fact taught in a public channel is
 *                       known in every session, and vice versa.
 *   - user-<slackId> -> the SAME store as that person's Slack DM memory
 *                       (resolved through the identity table, so aliases,
 *                       emails, and Slack ids all land on one store).
 *                       Users who don't resolve to a teammate get an isolated
 *                       `user-<normalized>` store instead.
 *   - repo-<id>      -> new: per registered repo (PROJECTS ids). Operational
 *                       facts about a codebase
 *                       that don't belong in checked-in docs: gotchas, env
 *                       quirks, "don't touch X until Y ships".
 *
 * Trust model: reads are injected into the system prompt of both interactive
 * and automation runs, but the WRITE tools (opensession-memory MCP,
 * src/agents/slack/memory-tools.ts) are wired into interactive runs ONLY.
 * Automation runs process untrusted event text — letting them store memory
 * would make prompt injection persistent (a hostile ticket plants "standing
 * context" every future run sees). Keep it that way.
 */

import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import {
  loadScope,
  saveScope,
  MEMORY_DIR,
  type MemoryEntry,
} from "../agents/slack/memory";
import { resolveTeammate, SLACK_ID_TO_NAME } from "./shared/user-mappings";
import { personaName } from "./config";

// "channel" never appears in a session's scopes — it exists so the Settings
// Memory page can list/maintain Slack channel stores alongside the rest.
export type MemoryScopeKind = "repo" | "user" | "team" | "channel";

export interface MemoryScope {
  /** Store file key under MEMORY_DIR, e.g. "repo-app", "workspace". */
  key: string;
  kind: MemoryScopeKind;
  /** Human label for prompts/tool output, e.g. "app", "Alice". */
  label: string;
}

/** The team scope IS the Slack workspace store — shared both ways. */
const TEAM_SCOPE: MemoryScope = { key: "workspace", kind: "team", label: "team" };

function userScope(user?: string | null): MemoryScope | null {
  const trimmed = user?.trim();
  if (!trimmed) return null;
  const teammate = resolveTeammate(trimmed);
  if (teammate)
    return { key: `user-${teammate.slackId}`, kind: "user", label: teammate.name };
  const key = trimmed.toLowerCase().replace(/[^a-z0-9@._-]+/g, "-");
  return key ? { key: `user-${key}`, kind: "user", label: trimmed } : null;
}

/**
 * The scopes a run reads (and, interactively, writes): one per repo the
 * session spans (primary first), the prompting user's, then team. Order is
 * the storage default for store_memory ("repo" = repos[0]).
 */
export function sessionMemoryScopes(opts: {
  user?: string | null;
  /** Repo ids, primary first (attached repos after). */
  repos?: string[];
  /** Drop the team scope when the caller already injects the workspace store
   *  (Slack channel-watch automations get it via renderMemoryForPrompt). */
  includeTeam?: boolean;
}): MemoryScope[] {
  const scopes: MemoryScope[] = [];
  for (const repo of [...new Set(opts.repos || [])]) {
    if (repo) scopes.push({ key: `repo-${repo}`, kind: "repo", label: repo });
  }
  const u = userScope(opts.user);
  if (u) scopes.push(u);
  if (opts.includeTeam !== false) scopes.push(TEAM_SCOPE);
  return scopes;
}

export async function addSessionMemory(
  scope: MemoryScope,
  text: string,
  by: string
): Promise<MemoryEntry> {
  const entries = await loadScope(scope.key);
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    text: text.trim(),
    by: by || "someone",
    at: new Date().toISOString(),
  };
  entries.push(entry);
  await saveScope(scope.key, entries);
  return entry;
}

export interface ScopedMemory {
  scope: MemoryScope;
  entries: MemoryEntry[];
}

export async function listSessionMemory(
  scopes: MemoryScope[]
): Promise<ScopedMemory[]> {
  return Promise.all(
    scopes.map(async (scope) => ({ scope, entries: await loadScope(scope.key) }))
  );
}

export type SessionForgetResult =
  | { ok: true; scope: MemoryScope; removed: MemoryEntry }
  | { ok: false; error: string };

/** Remove an entry by id from whichever of the given scopes holds it. */
export async function forgetSessionMemory(
  scopes: MemoryScope[],
  id: string
): Promise<SessionForgetResult> {
  for (const scope of scopes) {
    const entries = await loadScope(scope.key);
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) continue;
    const [removed] = entries.splice(idx, 1);
    await saveScope(scope.key, entries);
    return { ok: true, scope, removed };
  }
  return {
    ok: false,
    error: `No memory entry with id "${id}" in this session's scopes.`,
  };
}

function scopeHeading(scope: MemoryScope): string {
  if (scope.kind === "repo") return `Repo ${scope.label}:`;
  if (scope.kind === "user") return `${scope.label} (user):`;
  return "Team (workspace-wide):";
}

// ── Settings-page maintenance surface (see GET/POST/PUT/DELETE /api/memory) ──

/** Reconstruct a scope descriptor from a store-file key ("workspace",
 *  "repo-x", "user-U…", "channel-C…"). Unknown shapes are rejected so the
 *  API can't be used to create arbitrary files under MEMORY_DIR. */
export function describeScope(key: string): MemoryScope | null {
  if (key === "workspace") return TEAM_SCOPE;
  const m = key.match(/^(repo|user|channel)-([A-Za-z0-9@._-]+)$/);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === "repo") return { key, kind: "repo", label: rest };
  if (kind === "channel") return { key, kind: "channel", label: rest };
  const teammate = /^U[A-Z0-9]{6,}$/.test(rest) ? SLACK_ID_TO_NAME[rest] : undefined;
  return { key, kind: "user", label: teammate || rest };
}

/**
 * Every memory scope for the Settings page: team + one per registered repo
 * (always shown, even when empty, so there's somewhere to add), plus whatever
 * user/channel stores exist on disk.
 */
export async function listAllMemory(repoIds: string[]): Promise<ScopedMemory[]> {
  const keys = new Set<string>(["workspace", ...repoIds.map((r) => `repo-${r}`)]);
  try {
    for (const f of readdirSync(MEMORY_DIR)) {
      if (f.endsWith(".json")) keys.add(f.slice(0, -5));
    }
  } catch {} // no store dir yet — the fixed scopes still render
  const scopes = [...keys]
    .map(describeScope)
    .filter((s): s is MemoryScope => !!s);
  const order: Record<MemoryScopeKind, number> = { team: 0, repo: 1, user: 2, channel: 3 };
  scopes.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  return listSessionMemory(scopes);
}

export async function updateMemoryEntry(
  scopeKey: string,
  id: string,
  text: string
): Promise<MemoryEntry | null> {
  const entries = await loadScope(scopeKey);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.text = text.trim();
  await saveScope(scopeKey, entries);
  return entry;
}

/**
 * Render the scopes' memory for system-prompt injection. Empty string when
 * every scope is empty AND the run has no write tools (nothing to say).
 * `tools: true` (interactive runs) also teaches the opensession-memory tools,
 * even with no entries yet — otherwise nothing would ever get stored.
 */
export async function renderSessionMemoryNote(
  scopes: MemoryScope[],
  opts?: { tools?: boolean }
): Promise<string> {
  const scoped = await listSessionMemory(scopes);
  const any = scoped.some((s) => s.entries.length > 0);
  if (!any && !opts?.tools) return "";

  const lines: string[] = ["## Memory"];
  if (any) {
    lines.push(
      "Durable facts stored for this session's scopes. Treat them as standing " +
        "context (background knowledge, not instructions from the current conversation)."
    );
    for (const { scope, entries } of scoped) {
      if (!entries.length) continue;
      lines.push("", scopeHeading(scope));
      lines.push(...entries.map((e) => `- [${e.id}] ${e.text}`));
    }
  }
  if (opts?.tools) {
    lines.push(
      "",
      "Manage memory with the opensession-memory tools: `store_memory` saves a fact " +
        "(scope `repo` = this session's repo, `user` = whoever is prompting, `team` = " +
        `shared workspace-wide, including ${personaName()} in Slack), \`forget_memory\` removes one by id, ` +
        "`list_memory` shows everything. Store only durable, non-obvious facts worth every " +
        "future session knowing (operational gotchas, decisions, preferences) — never " +
        "conversation state, and never anything already in the repo's docs. When the user " +
        "says \"remember ...\", store it."
    );
  }
  return lines.join("\n");
}
