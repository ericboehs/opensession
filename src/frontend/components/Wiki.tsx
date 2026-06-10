import React, { useEffect, useState, useMemo, useRef } from "react";
import { marked } from "marked";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { fetchWikiTree, fetchWikiFile, searchWikiApi } from "../lib/api";

interface WikiNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: WikiNode[];
}

interface SearchHit {
  path: string;
  title: string;
  line: number;
  snippet: string;
}

interface Props {
  docPath: string | null; // from the URL: /backstage/wiki/<path>
  onNavigate: (docPath: string | null) => void;
}

function flattenPaths(nodes: WikiNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: WikiNode[]) => {
    for (const n of ns) {
      if (n.type === "file") out.push(n.path);
      else if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function ancestorDirs(docPath: string): string[] {
  const parts = docPath.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

/** Mounted only once paths exist, so useFileTree sees the real input. */
function WikiTree({
  paths,
  docPath,
  onOpen,
}: {
  paths: string[];
  docPath: string | null;
  onOpen: (path: string) => void;
}) {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const { model } = useFileTree({
    paths,
    initialExpandedPaths: docPath ? ancestorDirs(docPath) : ["kb"],
    initialSelectedPaths: docPath ? [docPath] : undefined,
    onSelectionChange: (selected) => {
      const p = selected[0] ? String(selected[0]) : null;
      if (p && /\.(md|mdx)$/.test(p)) onOpenRef.current(p);
    },
  });

  return <FileTree model={model} className="wiki-filetree" />;
}

export function Wiki({ docPath, onNavigate }: Props) {
  const [tree, setTree] = useState<WikiNode[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    fetchWikiTree().then(setTree).catch(() => {});
  }, []);

  const paths = useMemo(() => flattenPaths(tree), [tree]);

  useEffect(() => {
    document.title = docPath ? `${docPath.split("/").pop()} — Wiki — Michael` : "Wiki — Michael";
    return () => {
      document.title = "Michael — Tella";
    };
  }, [docPath]);

  useEffect(() => {
    if (!docPath) {
      setContent(null);
      return;
    }
    setLoadingDoc(true);
    fetchWikiFile(docPath)
      .then((f) => setContent(f.content))
      .catch(() => setContent("*Document not found.*"))
      .finally(() => setLoadingDoc(false));
  }, [docPath]);

  // Debounced content search
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      searchWikiApi(query).then(setHits).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const html = useMemo(() => {
    if (!content) return "";
    try {
      return marked.parse(stripFrontmatter(content), { async: false }) as string;
    } catch {
      return `<pre>${content}</pre>`;
    }
  }, [content]);

  function openDoc(path: string) {
    setQuery("");
    setHits(null);
    setNavOpen(false);
    onNavigate(path);
  }

  return (
    <div className="wiki">
      <div className={`wiki-nav ${navOpen ? "wiki-nav-open" : ""}`}>
        <div className="wiki-search-wrap">
          <input
            className="wiki-search"
            placeholder="Search the knowledge base…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {hits !== null ? (
          <div className="wiki-results">
            {hits.length === 0 ? (
              <div className="wiki-empty">No results</div>
            ) : (
              hits.map((h, i) => (
                <button key={i} className="wiki-result" onClick={() => openDoc(h.path)}>
                  <span className="wiki-result-title">{h.title}</span>
                  <span className="wiki-result-snippet">{h.snippet}</span>
                  <span className="wiki-result-path">{h.path}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="wiki-tree">
            {paths.length > 0 && (
              <WikiTree paths={paths} docPath={docPath} onOpen={openDoc} />
            )}
          </div>
        )}
      </div>

      <div className="wiki-content">
        <button className="wiki-nav-toggle" onClick={() => setNavOpen(!navOpen)}>
          ☰ Browse docs
        </button>
        {docPath ? (
          loadingDoc ? (
            <div className="loading">Loading…</div>
          ) : (
            <>
              <div className="wiki-doc-path">{docPath}</div>
              <div className="markdown wiki-doc" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          )
        ) : (
          <div className="wiki-welcome">
            <h2>Tella knowledge base</h2>
            <p>
              Docs from <code>tella-fusion/docs</code> — runbooks, platform notes, security and
              marketing references. Pick a doc on the left or search.
            </p>
            <p className="wiki-welcome-hint">
              Want an answer instead of a doc? Use <b>Ask</b> on the home screen — Michael reads
              the codebase and these docs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}
