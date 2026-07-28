/**
 * Read-only wiki over the default repository's knowledge base (docs/).
 * Tree + file + naive full-text search. Paths are validated to stay
 * inside the docs root.
 */
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "fs";
import { join, resolve, relative } from "path";
import { defaultRepo } from "./config";

const HOME = process.env.HOME || "";
const docsRoot = () => `${defaultRepo().repo}/docs`;

export interface WikiNode {
  name: string;
  path: string; // relative to docs root
  type: "dir" | "file";
  children?: WikiNode[];
}

export interface WikiSearchHit {
  path: string;
  title: string;
  line: number;
  snippet: string;
}

const SKIP_DIRS = new Set(["images", "node_modules", ".git"]);

function isDoc(name: string): boolean {
  return name.endsWith(".md") || name.endsWith(".mdx");
}

export function getWikiTree(): WikiNode[] {
  if (!existsSync(docsRoot())) return [];
  return walk(docsRoot(), "");
}

function walk(abs: string, rel: string): WikiNode[] {
  const nodes: WikiNode[] = [];
  let items: string[];
  try {
    items = readdirSync(abs);
  } catch {
    return nodes;
  }

  const dirs: WikiNode[] = [];
  const files: WikiNode[] = [];

  for (const name of items.sort()) {
    if (name.startsWith(".")) continue;
    const childAbs = join(abs, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      const children = walk(childAbs, childRel);
      if (children.length > 0) {
        dirs.push({ name, path: childRel, type: "dir", children });
      }
    } else if (isDoc(name)) {
      files.push({ name, path: childRel, type: "file" });
    }
  }

  nodes.push(...dirs, ...files);
  return nodes;
}

/** Resolve a user-supplied relative path safely inside the docs root. */
function safeResolve(relPath: string): string | null {
  const root = docsRoot();
  const abs = resolve(root, relPath);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  const rootReal = realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + "/")) return null;
  return real;
}

export function getWikiFile(relPath: string): { path: string; content: string } | null {
  if (!isDoc(relPath)) return null;
  const abs = safeResolve(relPath);
  if (!abs) return null;
  try {
    return { path: relPath, content: readFileSync(abs, "utf-8") };
  } catch {
    return null;
  }
}

export function searchWiki(query: string, limit = 40): WikiSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const hits: WikiSearchHit[] = [];
  const stack = [...getWikiTree()];

  while (stack.length > 0 && hits.length < limit) {
    const node = stack.shift()!;
    if (node.type === "dir") {
      stack.unshift(...(node.children || []));
      continue;
    }

    const file = getWikiFile(node.path);
    if (!file) continue;

    const lines = file.content.split("\n");
    const title = extractTitle(lines, node.name);

    // Filename match counts as a hit
    if (node.path.toLowerCase().includes(q)) {
      hits.push({ path: node.path, title, line: 0, snippet: title });
      if (hits.length >= limit) break;
    }

    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(q);
      if (idx === -1) continue;
      hits.push({
        path: node.path,
        title,
        line: i + 1,
        snippet: makeSnippet(lines[i], idx, q.length),
      });
      break; // one content hit per file keeps results scannable
    }
  }

  return hits;
}

function extractTitle(lines: string[], fallback: string): string {
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return fallback.replace(/\.(md|mdx)$/, "");
}

function makeSnippet(line: string, idx: number, qlen: number): string {
  const start = Math.max(0, idx - 60);
  const end = Math.min(line.length, idx + qlen + 60);
  return (start > 0 ? "…" : "") + line.slice(start, end).trim() + (end < line.length ? "…" : "");
}

export function getDocsRootRelative(): string {
  return relative(HOME, docsRoot());
}
