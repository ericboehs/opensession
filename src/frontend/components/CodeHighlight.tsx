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
import rust from "@shikijs/langs/rust";
import swift from "@shikijs/langs/swift";
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";
// Shiki ships no ReScript grammar — vendored from rescript-vscode
import rescriptGrammar from "../lib/rescript.tmLanguage.json";

const rescript = { ...(rescriptGrammar as any), name: "rescript" };

// Singleton highlighter, created on first use. Fine-grained core with the
// JS regex engine keeps the bundle small (no WASM, only the langs we list).
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDark, githubLight],
      langs: [
        bash, typescript, tsx, javascript, jsx, json, css, html,
        yaml, markdown, sql, diff, toml, rust, swift, rescript,
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

function getResolvedTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useResolvedTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(getResolvedTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(getResolvedTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
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
  const theme = useResolvedTheme();

  useEffect(() => {
    let alive = true;
    setHtml(null);
    getHighlighter()
      .then((h) => {
        if (!alive) return;
        const split = gutter ? splitGutter(code) : null;
        if (requireGutter && !split) return; // leave the plain-pre fallback
        setHtml(
          h.codeToHtml(split ? split.code : code, {
            lang,
            theme: theme === "light" ? "github-light-default" : "github-dark-default",
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
  }, [code, lang, gutter, requireGutter, theme]);

  if (html === null) return <pre className="tool-pre">{code}</pre>;
  return <div className="tool-pre tool-pre-code" dangerouslySetInnerHTML={{ __html: html }} />;
}
