// Skill/command index for "/"-skill autocomplete in the composer.
//
// Mirrors what a run actually loads: OpenCode's global skills and user-level
// ~/.claude/commands, plus the checkout's .claude/ and .agents/ skills and
// commands. Skills are matched the
// way the engine globs them — `skills/**\/SKILL.md`, so nested ones count —
// plus the skills the engine embeds in its binary (SYSTEM_SKILLS), which no
// directory scan can see. Cached briefly per directory so keystrokes only
// re-filter in memory.

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SkillEntry {
  /** Slash-command name, without the leading "/". */
  name: string;
  /** One-line description from frontmatter (or first content line). */
  description: string;
  /** Where it came from: the engine itself, user config, the session's checkout, or opensession. */
  source: "system" | "user" | "project" | "builtin";
}

/**
 * Skills the engine embeds in its own binary — real, invocable skills that no
 * directory scan can find. opencode ships exactly one today; Claude Code's
 * bundled set (/simplify, /code-review, …) is compiled into *its* binary and is
 * NOT reachable from an opencode run, so it deliberately isn't listed here —
 * Open Session installs its tracked ports into ~/.config/opencode/skills.
 * Keep in sync when the engine's embedded set changes (`GET /skill` on a
 * running opencode server lists them with `source.type === "embedded"`).
 */
const SYSTEM_SKILLS: SkillEntry[] = [
  {
    name: "customize-opencode",
    description:
      "Editing or creating opencode's own configuration — opencode.json(c), .opencode/, agents, skills, plugins, MCP servers, permission rules",
    source: "system",
  },
];

/**
 * Open Session's own slash commands (handled by handleSlashCommand in opensession.ts
 * before anything reaches the runner). Listed here so they show up in the
 * composer's "/" autocomplete alongside file-based skills/commands — keep in
 * sync with the handler and its /help text.
 */
const BUILTIN_COMMANDS: SkillEntry[] = [
  {
    name: "compact",
    description:
      "Summarize the conversation so far to shrink context and cost (Claude sessions only)",
    source: "builtin",
  },
  {
    name: "goal",
    description:
      "Pin a goal appended to every prompt until cleared (/goal <text>, /goal clear)",
    source: "builtin",
  },
  {
    name: "loop",
    description:
      "Re-run a prompt on an interval while idle (/loop 30m <prompt>, /loop stop)",
    source: "builtin",
  },
  {
    name: "model",
    description: "Show or switch this session's model (/model, /model <name>)",
    source: "builtin",
  },
  {
    name: "account",
    description:
      "Show or pin the current model provider account (/account, /account <name>, /account auto)",
    source: "builtin",
  },
  {
    name: "help",
    description: "List opensession slash commands",
    source: "builtin",
  },
];

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { entries: SkillEntry[]; at: number }>();

/** Frontmatter `key: value` (quoted or bare), from the first --- block only. */
function frontmatterField(text: string, key: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** First non-frontmatter, non-heading content line — fallback description. */
function firstContentLine(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return "";
}

/**
 * Skills under `dir`, matching the engine's `skills/**\/SKILL.md` glob — so a
 * SKILL.md nested below its skills root (grouped in a subfolder) is found too,
 * not just `<dir>/<name>/SKILL.md`. Depth-bounded; skips dot-dirs.
 */
function readSkillsDir(
  dir: string,
  source: SkillEntry["source"],
  depth = 4,
  out: SkillEntry[] = [],
): SkillEntry[] {
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name.startsWith(".")) continue;
      const sub = join(dir, name.name);
      if (!name.isDirectory()) {
        try {
          if (!statSync(sub).isDirectory()) continue;
        } catch {
          continue;
        }
      }
      const md = join(sub, "SKILL.md");
      if (existsSync(md)) {
        try {
          const text = readFileSync(md, "utf8");
          out.push({
            name: frontmatterField(text, "name") || name.name,
            description: frontmatterField(text, "description") || firstContentLine(text),
            source,
          });
        } catch {}
        continue; // a skill's own files never hold another skill
      }
      if (depth > 1) readSkillsDir(sub, source, depth - 1, out);
    }
  } catch {}
  return out;
}

function readCommandsDir(dir: string, source: SkillEntry["source"]): SkillEntry[] {
  const out: SkillEntry[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const text = readFileSync(join(dir, file), "utf8");
        out.push({
          name: file.slice(0, -3),
          description: frontmatterField(text, "description") || firstContentLine(text),
          source,
        });
      } catch {}
    }
  } catch {}
  return out;
}

/** All skills + commands a run in `worktreeDir` would see (deduped by name; project wins). */
function loadSkills(worktreeDir?: string, includeBuiltins = false): SkillEntry[] {
  const key = `${includeBuiltins ? "b|" : ""}${worktreeDir || ""}`;
  const hit = cache.get(key);
  if (hit && performance.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  const user = join(homedir(), ".claude");
  const opencode = join(homedir(), ".config", "opencode");
  const byName = new Map<string, SkillEntry>();
  const all = [
    // First so a same-named file skill (which shadows it in the engine too)
    // wins dedupe and the menu describes what would actually run.
    ...SYSTEM_SKILLS,
    ...readSkillsDir(join(opencode, "skills"), "user"),
    ...readCommandsDir(join(user, "commands"), "user"),
    ...(worktreeDir ? readSkillsDir(join(worktreeDir, ".claude", "skills"), "project") : []),
    ...(worktreeDir ? readCommandsDir(join(worktreeDir, ".claude", "commands"), "project") : []),
    // .agents is the engine's other project root — the same dir as .claude in
    // repos that symlink the two, a distinct one in repos that don't.
    ...(worktreeDir ? readSkillsDir(join(worktreeDir, ".agents", "skills"), "project") : []),
    ...(worktreeDir ? readCommandsDir(join(worktreeDir, ".agents", "commands"), "project") : []),
    // Last so they win dedupe: opensession intercepts these names before any
    // same-named file skill could run, so the menu should describe the builtin.
    // Only for existing-session composers (includeBuiltins) — an opening prompt
    // in the new-session palette never passes through handleSlashCommand.
    ...(includeBuiltins ? BUILTIN_COMMANDS : []),
  ];
  for (const e of all) byName.set(e.name, e); // later entries override earlier ones
  const entries = [...byName.values()];
  cache.set(key, { entries, at: performance.now() });
  return entries;
}

/** Filter + rank skills for a typed query (prefix beats substring beats description hit). */
export function searchSkills(
  worktreeDir: string | undefined,
  query: string,
  limit = 24,
  includeBuiltins = false,
): SkillEntry[] {
  const q = query.toLowerCase();
  const scored: Array<{ e: SkillEntry; score: number }> = [];
  for (const e of loadSkills(worktreeDir, includeBuiltins)) {
    const name = e.name.toLowerCase();
    let score: number;
    if (!q) score = 1;
    else if (name.startsWith(q)) score = 3000 - name.length;
    else if (name.includes(q)) score = 2000 - name.length;
    else if (e.description.toLowerCase().includes(q)) score = 1000;
    else continue;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((s) => s.e);
}
