/**
 * opensession-memory — an in-process MCP server giving sessions durable
 * memory across three scopes (src/server/session-memory.ts):
 *
 *   repo — facts about the session's codebase (repo-<id> stores)
 *   user — facts about the prompting person (shared with their Slack DM memory)
 *   team — workspace-wide facts (the SAME store as Slack public-channel memory)
 *
 * Wired the same way as the opensession-* siblings: interactive runs only
 * (Open Session web sessions), NEVER automations. Automation runs process
 * untrusted event/ticket text — a write tool here would make prompt injection
 * persistent (plant a "fact" once, poison every future run). Automations get
 * read-only injection instead (runAutomation appends renderSessionMemoryNote).
 *
 * All in-process servers are opensession-* named; canonicalMcpServerId in
 * rename-compat folds the pre-rename ids onto them for journaled runs.
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { personaName } from "../../server/config";
import {
  addSessionMemory,
  archiveMemories,
  forgetSessionMemory,
  invalidateMemorySnapshot,
  listSessionMemory,
  renderSessionMemoryNote,
  searchSessionMemory,
  sessionMemoryScopes,
  type MemoryScope,
} from "../../server/session-memory";

export interface MemoryToolContext {
  /** Whoever is prompting — resolves the user scope + attribution. */
  user?: string;
  /** Repo ids the session currently spans, primary first. Called per tool
   *  invocation so a repo attached mid-session is picked up. */
  repos: () => string[];
  /** This session's id, so a write can refresh its own injected-memory
   *  snapshot (see snapshotMemoryNote). Absent for non-session callers. */
  sessionId?: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function scopesFor(ctx: MemoryToolContext): MemoryScope[] {
  return sessionMemoryScopes({ user: ctx.user, repos: ctx.repos() });
}

export function createMemoryMcpServer(ctx: MemoryToolContext) {
  const tools = [
    tool(
      "store_memory",
      "Store a durable fact in memory so future sessions know it without being told. " +
        "Scopes: 'repo' (default) = facts about this session's codebase (gotchas, operational " +
        "quirks, decisions — things that don't belong in checked-in docs); 'user' = facts about " +
        "the person prompting (preferences, context); 'team' = workspace-wide facts everyone " +
        `(including ${personaName()} in Slack) should know. Store only durable, non-obvious facts — never ` +
        "conversation state, never things already in the repo's docs.",
      {
        text: z.string().describe("The fact to remember, one self-contained sentence or two."),
        scope: z
          .enum(["repo", "user", "team"])
          .optional()
          .describe("Where it belongs. Defaults to 'repo'."),
        repo: z
          .string()
          .optional()
          .describe(
            "Repo id when scope is 'repo' and the session spans multiple repos. Defaults to the primary repo."
          ),
        supersedes: z
          .array(z.string())
          .optional()
          .describe(
            "Ids of entries this one replaces, from the [id] tags in the Memory section. " +
              "ALWAYS set this when you are correcting something already remembered, instead of " +
              "writing 'CORRECTION to memory X' in the text: the entries you name are archived, so " +
              "the wrong version stops being injected and future sessions read one fact rather than " +
              "reconciling several. They stay recoverable through search_memory. Leave it unset when " +
              "the earlier entry is still true and yours only adds to it."
          ),
      },
      async (args: {
        text: string;
        scope?: "repo" | "user" | "team";
        repo?: string;
        supersedes?: string[];
      }) => {
        const body = args.text?.trim();
        if (!body) return text("Nothing to store — `text` was empty.");
        const kind = args.scope || "repo";
        const scopes = scopesFor(ctx);
        let target: MemoryScope | undefined;
        if (kind === "repo") {
          target = args.repo
            ? scopes.find((s) => s.kind === "repo" && s.label === args.repo)
            : scopes.find((s) => s.kind === "repo");
          if (!target)
            return text(
              args.repo
                ? `This session doesn't span repo "${args.repo}" — its repos: ${
                    scopes.filter((s) => s.kind === "repo").map((s) => s.label).join(", ") || "none"
                  }.`
                : "This session has no resolvable repo — use scope 'user' or 'team'."
            );
        } else {
          target = scopes.find((s) => s.kind === kind);
          if (!target)
            return text(
              "No user scope for this session (unknown prompter) — use scope 'repo' or 'team'."
            );
        }
        const entry = await addSessionMemory(target, body, ctx.user || "session", {
          supersedes: args.supersedes,
          scopes,
        });
        invalidateMemorySnapshot(ctx.sessionId);
        const lines = [
          `Remembered in ${target.kind} scope (${target.label}) as [${entry.id}]: ${entry.text}`,
        ];
        if (args.supersedes?.length) {
          const known = new Set(
            (await listSessionMemory(scopes, { includeArchived: true }))
              .flatMap((s) => s.entries)
              .filter((e) => e.supersededBy === entry.id)
              .map((e) => e.id)
          );
          const missed = args.supersedes.filter((id) => !known.has(id));
          lines.push(
            `Archived ${known.size} superseded ${known.size === 1 ? "entry" : "entries"}; they no longer take up prompt but stay searchable.`
          );
          if (missed.length)
            lines.push(`Not found in this session's scopes: ${missed.join(", ")}.`);
        }
        return text(lines.join("\n"));
      }
    ),
    tool(
      "search_memory",
      "Search everything ever remembered for this session's scopes, including entries that are " +
        "no longer injected — older facts held back to keep the Memory section a sane size, and " +
        "entries superseded by a later correction. Reach for this before re-deriving something " +
        "that smells familiar, or when the Memory section says entries were held back. Exact " +
        "tokens work best: file names, error strings, flag names.",
      {
        query: z.string().describe("Search terms. Every term must appear in an entry to match."),
        limit: z.number().optional().describe("Maximum results (default 10, max 50)."),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include superseded entries. Default true."),
      },
      async (args: { query: string; limit?: number; includeArchived?: boolean }) => {
        const hits = await searchSessionMemory(scopesFor(ctx), args.query || "", {
          limit: args.limit,
          includeArchived: args.includeArchived,
        });
        if (!hits.length)
          return text(`No memory entry matches "${args.query}". Try fewer or broader terms.`);
        return text(
          hits
            .map(
              (h) =>
                `- [${h.entry.id}] (${h.scope.kind}: ${h.scope.label}${h.archived ? ", superseded" : ""}) ${h.entry.text}`
            )
            .join("\n")
        );
      }
    ),
    tool(
      "supersede_memory",
      "Archive memory entries that are wrong or obsolete, without storing a replacement. They " +
        "stop being injected but stay reachable through search_memory. Use forget_memory only " +
        "when an entry should not have been recorded at all.",
      {
        ids: z.array(z.string()).describe("Entry ids to archive, from the [id] tags."),
      },
      async (args: { ids: string[] }) => {
        const res = await archiveMemories(scopesFor(ctx), args.ids || []);
        invalidateMemorySnapshot(ctx.sessionId);
        const lines = res.archived.map(
          (a) => `Archived [${a.entry.id}] from ${a.scope.kind} scope (${a.scope.label}).`
        );
        if (res.missing.length)
          lines.push(`Not found in this session's scopes: ${res.missing.join(", ")}.`);
        return text(lines.join("\n") || "Nothing to archive.");
      }
    ),
    tool(
      "list_memory",
      "List everything in this session's memory scopes (repo(s), user, team) with the ids needed to forget entries.",
      {},
      async () => {
        const scoped = await listSessionMemory(scopesFor(ctx));
        const lines: string[] = [];
        for (const { scope, entries } of scoped) {
          lines.push(`${scope.kind}: ${scope.label} — ${entries.length ? "" : "(empty)"}`);
          for (const e of entries) lines.push(`  - [${e.id}] ${e.text} (${e.by}, ${e.at.slice(0, 10)})`);
        }
        return text(lines.join("\n"));
      }
    ),
    tool(
      "forget_memory",
      "Remove a memory entry by id (see list_memory or the [id] tags in the Memory section). Works on any of this session's scopes.",
      {
        id: z.string().describe("The entry id to remove."),
      },
      async (args: { id: string }) => {
        const res = await forgetSessionMemory(scopesFor(ctx), args.id.trim());
        invalidateMemorySnapshot(ctx.sessionId);
        if (!res.ok) return text(res.error);
        return text(
          `Forgot [${args.id}] from ${res.scope.kind} scope (${res.scope.label}): ${res.removed.text}`
        );
      }
    ),
  ];

  return createSdkMcpServer({ name: "opensession-memory", version: "1.0.0", tools });
}

/** Prompt note for this context's scopes — same view the tools operate on. */
export async function renderMemoryNoteFor(ctx: MemoryToolContext): Promise<string> {
  return renderSessionMemoryNote(scopesFor(ctx), { tools: true });
}
