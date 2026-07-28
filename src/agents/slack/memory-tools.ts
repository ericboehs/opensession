/**
 * opensession-memory — an in-process MCP server giving sessions durable
 * memory across three scopes (src/server/session-memory.ts):
 *
 *   repo — facts about the session's codebase (repo-<id> stores)
 *   user — facts about the prompting person (shared with their Slack DM memory)
 *   team — workspace-wide facts (the SAME store as Slack public-channel memory)
 *
 * Wired the same way as the opensession-* siblings: interactive runs only
 * (OpenSession web sessions), NEVER automations. Automation runs process
 * untrusted event/ticket text — a write tool here would make prompt injection
 * persistent (plant a "fact" once, poison every future run). Automations get
 * read-only injection instead (runAutomation appends renderSessionMemoryNote).
 *
 * All in-process servers are opensession-* named (michael-* renamed
 * 2026-07-09; canonicalMcpServerId in rename-compat covers legacy ids).
 */

import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { personaName } from "../../server/config";
import {
  addSessionMemory,
  forgetSessionMemory,
  listSessionMemory,
  renderSessionMemoryNote,
  sessionMemoryScopes,
  type MemoryScope,
} from "../../server/session-memory";

export interface MemoryToolContext {
  /** Whoever is prompting — resolves the user scope + attribution. */
  user?: string;
  /** Repo ids the session currently spans, primary first. Called per tool
   *  invocation so a repo attached mid-session is picked up. */
  repos: () => string[];
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
      },
      async (args: { text: string; scope?: "repo" | "user" | "team"; repo?: string }) => {
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
        const entry = await addSessionMemory(target, body, ctx.user || "session");
        return text(
          `Remembered in ${target.kind} scope (${target.label}) as [${entry.id}]: ${entry.text}`
        );
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
