import React, { useEffect, useState } from "react";
import { createHighlighterCore, type HighlighterCore, type ShikiTransformer } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "@shikijs/langs/bash";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import yaml from "@shikijs/langs/yaml";
import markdown from "@shikijs/langs/markdown";
import sql from "@shikijs/langs/sql";
import diff from "@shikijs/langs/diff";
import toml from "@shikijs/langs/toml";
import githubDark from "@shikijs/themes/github-dark-default";
// Shiki ships no ReScript grammar — vendored from rescript-vscode
import rescriptGrammar from "../lib/rescript.tmLanguage.json";

const rescript = { ...(rescriptGrammar as any), name: "rescript" };

const LANG_BY_EXT: Record<string, string> = {
  res: "rescript",
  resi: "rescript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

/** Map a file path to a registered shiki lang, or null if we can't highlight it. */
export function langForFile(filePath: unknown): string | null {
  if (typeof filePath !== "string") return null;
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANG_BY_EXT[ext] || null;
}

/** Infer a lang from Grep input: a file path, a "*.res"-style glob, or a ripgrep type. */
export function langForGrep(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  const fromPath = langForFile(inp.path);
  if (fromPath) return fromPath;
  if (typeof inp.glob === "string") {
    const ext = inp.glob.match(/\.(\w+)$/)?.[1]?.toLowerCase();
    if (ext && LANG_BY_EXT[ext]) return LANG_BY_EXT[ext];
  }
  if (typeof inp.type === "string" && LANG_BY_EXT[inp.type]) return LANG_BY_EXT[inp.type];
  return null;
}

// Singleton highlighter, created on first use. Fine-grained core with the
// JS regex engine keeps the bundle small (no WASM, only the langs we list).
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark],
      langs: [
        bash, typescript, tsx, javascript, jsx, json, css, html,
        yaml, markdown, sql, diff, toml, rescript,
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/**
 * Tool output carries a line-number gutter that confuses the grammars:
 * Read is cat -n style ("  348\t<code>"), Grep is rg -n style ("348:<code>"
 * match lines, "348-<code>" context lines, "--" group separators). Split the
 * gutter off, highlight the bare code, and re-attach the numbers as a faint
 * non-selectable gutter span.
 */
function splitGutter(content: string): { nums: string[]; code: string } | null {
  const lines = content.split("\n");
  const formats: { re: RegExp; sep?: string }[] = [
    { re: /^(\s*\d+)\t/ }, // Read: cat -n
    { re: /^(\d+[-:])/, sep: "--" }, // Grep: rg -n with context
  ];

  for (const { re, sep } of formats) {
    const matches = lines.map((l) => l.match(re));
    const isSep = lines.map((l) => sep !== undefined && l === sep);
    const nonEmpty = lines.filter((l) => l.length > 0).length;
    const matched = matches.filter(Boolean).length + isSep.filter(Boolean).length;
    if (matched === 0 || matched < nonEmpty * 0.8) continue;

    const width = Math.max(...matches.map((m) => (m ? m[1].length : 0)));
    return {
      nums: lines.map((l, i) =>
        isSep[i] ? sep! : matches[i] ? matches[i]![1].padStart(width) + " " : ""
      ),
      code: lines
        .map((l, i) => (isSep[i] ? "" : matches[i] ? l.slice(matches[i]![0].length) : l))
        .join("\n"),
    };
  }
  return null;
}

function gutterTransformer(nums: string[]): ShikiTransformer {
  return {
    line(node, line) {
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: { class: "shiki-gutter" },
        children: [{ type: "text", value: nums[line - 1] ?? "" }],
      });
    },
  };
}

interface Props {
  code: string;
  lang: string;
  /** Parse and preserve a line-number gutter (Read/Grep tool output). */
  gutter?: boolean;
  /** Only highlight when a gutter was actually found (e.g. Grep output may be bare file paths). */
  requireGutter?: boolean;
}

/** Syntax-highlighted code block; falls back to a plain pre until (or if) shiki is ready. */
export function CodeHighlight({ code, lang, gutter, requireGutter }: Props) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => {
        if (!alive) return;
        const split = gutter ? splitGutter(code) : null;
        if (requireGutter && !split) return; // leave the plain-pre fallback
        setHtml(
          h.codeToHtml(split ? split.code : code, {
            lang,
            theme: "github-dark-default",
            transformers: split ? [gutterTransformer(split.nums)] : [],
          })
        );
      })
      .catch((e) => {
        console.error("[shiki] highlight failed:", e);
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [code, lang, gutter]);

  if (html === null) return <pre className="tool-pre">{code}</pre>;
  return <div className="tool-pre tool-pre-code" dangerouslySetInnerHTML={{ __html: html }} />;
}
