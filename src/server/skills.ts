// Skill/command index for "/"-skill autocomplete in the composer.
//
// Mirrors what a Claude run actually loads via `settingSources: ["user",
// "project"]` (claude-runner.ts): user-level ~/.claude/skills/*/SKILL.md and
// ~/.claude/commands/*.md, plus the checkout's .claude/skills and
// .claude/commands (tella-fusion symlinks .claude/skills -> .agents/skills,
// which readdir follows). Cached briefly per directory so keystrokes only
// re-filter in memory.

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SkillEntry {
  /** Slash-command name, without the leading "/". */
  name: string;
  /** One-line description from frontmatter (or first content line). */
  description: string;
  /** Where it came from: user-level config or the session's checkout. */
  source: "user" | "project";
}

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

function readSkillsDir(dir: string, source: SkillEntry["source"]): SkillEntry[] {
  const out: SkillEntry[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const md = join(dir, name, "SKILL.md");
      if (!existsSync(md)) continue;
      try {
        const text = readFileSync(md, "utf8");
        out.push({
          name: frontmatterField(text, "name") || name,
          description: frontmatterField(text, "description") || firstContentLine(text),
          source,
        });
      } catch {}
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

/** All skills + commands a Claude run in `worktreeDir` would see (deduped by name; project wins). */
function loadSkills(worktreeDir?: string): SkillEntry[] {
  const key = worktreeDir || "";
  const hit = cache.get(key);
  if (hit && performance.now() - hit.at < CACHE_TTL_MS) return hit.entries;

  const user = join(homedir(), ".claude");
  const byName = new Map<string, SkillEntry>();
  const all = [
    ...readSkillsDir(join(user, "skills"), "user"),
    ...readCommandsDir(join(user, "commands"), "user"),
    ...(worktreeDir ? readSkillsDir(join(worktreeDir, ".claude", "skills"), "project") : []),
    ...(worktreeDir ? readCommandsDir(join(worktreeDir, ".claude", "commands"), "project") : []),
  ];
  for (const e of all) byName.set(e.name, e); // later (project) entries override user ones
  const entries = [...byName.values()];
  cache.set(key, { entries, at: performance.now() });
  return entries;
}

/** Filter + rank skills for a typed query (prefix beats substring beats description hit). */
export function searchSkills(worktreeDir: string | undefined, query: string, limit = 24): SkillEntry[] {
  const q = query.toLowerCase();
  const scored: Array<{ e: SkillEntry; score: number }> = [];
  for (const e of loadSkills(worktreeDir)) {
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
