import React, { useEffect, useState, useMemo, useCallback } from "react";
import { marked } from "marked";
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

export function Wiki({ docPath, onNavigate }: Props) {
  const [tree, setTree] = useState<WikiNode[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    fetchWikiTree().then(setTree).catch(() => {});
  }, []);

  useEffect(() => {
    document.title = docPath ? `${docPath.split("/").pop()} — Wiki — Michael` : "Wiki — Michael";
    return () => {
      document.title = "Michael — Tella";
    };
  }, [docPath]);

  // Auto-expand ancestors of the open doc
  useEffect(() => {
    if (!docPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = docPath.split("/");
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
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

  // Debounced search
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

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
            {tree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selected={docPath}
                expanded={expanded}
                onToggle={toggleDir}
                onOpen={openDoc}
              />
            ))}
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

function TreeNode({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onOpen,
}: {
  node: WikiNode;
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (node.type === "dir") {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <button
          className="wiki-dir"
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onToggle(node.path)}
        >
          <span className="wiki-chevron">{isOpen ? "▾" : "▸"}</span>
          {node.name}
        </button>
        {isOpen &&
          node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
      </>
    );
  }

  return (
    <button
      className={`wiki-file ${selected === node.path ? "wiki-file-selected" : ""}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onClick={() => onOpen(node.path)}
    >
      {node.name.replace(/\.(md|mdx)$/, "")}
    </button>
  );
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const end = md.indexOf("\n---", 4);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}
