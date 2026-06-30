// File index for "@"-mention autocomplete in the composer.
//
// Lists the tracked + untracked-non-ignored files of a checkout (the same set
// `git status` would show) and fuzzy-filters them against a query. The full
// file list per directory is cached briefly so a burst of keystrokes doesn't
// re-shell `git ls-files` on every character — only the in-memory filter runs.

import { $ } from "bun";

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { files: string[]; at: number }>();

// Monotonic-ish clock without Date.now() (which is fine in server code, but a
// single source keeps it easy to reason about). performance.now() is process
// uptime in ms — perfect for a TTL.
function now(): number {
  return performance.now();
}

async function loadFiles(dir: string): Promise<string[]> {
  const hit = cache.get(dir);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.files;
  // --cached: tracked, --others --exclude-standard: untracked but not gitignored.
  // -z: NUL-separated so paths with spaces/newlines survive.
  const out = await $`git -C ${dir} ls-files --cached --others --exclude-standard -z`
    .quiet()
    .text();
  // Drop vendored dependency trees — they're tracked in some repos (backstage
  // commits node_modules) but are never useful "@"-mention targets and only
  // crowd out source files in the results.
  const files = out
    .split("\0")
    .filter(Boolean)
    .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"));
  cache.set(dir, { files, at: now() });
  return files;
}

/** Case-insensitive subsequence match returning a score (higher = better) or -1. */
function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (!q) {
    // No query: rank by shallowness then length so top-level files surface first.
    return 1000 - path.split("/").length * 10 - path.length * 0.1;
  }
  const base = p.slice(p.lastIndexOf("/") + 1);

  // Strong boosts for the common cases before falling back to subsequence.
  if (base === q) return 10_000 - path.length;
  if (base.startsWith(q)) return 8_000 - path.length;
  if (base.includes(q)) return 6_000 - path.length;
  if (p.includes(q)) return 4_000 - path.length;

  // Subsequence match anywhere in the full path.
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let pi = 0; pi < p.length && qi < q.length; pi++) {
    if (p[pi] === q[qi]) {
      qi++;
      streak++;
      score += streak; // reward consecutive matches
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1; // not all query chars matched
  return 1_000 + score - path.length * 0.1;
}

export function listRepoFiles(dir: string, query: string, limit = 20): string[] {
  const files = cacheSync(dir);
  if (!files) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const f of files) {
    const score = fuzzyScore(query, f);
    if (score >= 0) scored.push({ path: f, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

// The async loader populates the cache; this returns whatever is cached (may be
// undefined on the very first call before the warm-up resolves).
function cacheSync(dir: string): string[] | undefined {
  return cache.get(dir)?.files;
}

/** Resolve, fuzzy-filter and cap the file list for a directory (async-safe). */
export async function searchRepoFiles(dir: string, query: string, limit = 20): Promise<string[]> {
  await loadFiles(dir);
  return listRepoFiles(dir, query, limit);
}
