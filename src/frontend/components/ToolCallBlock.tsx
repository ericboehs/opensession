import React, { useState } from "react";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

/** Split "mcp__linear__list_issues" into { server: "linear", tool: "list_issues" }. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

export function ToolCallBlock({ entry, result }: Props) {
  const [expanded, setExpanded] = useState(false);
  const toolName = entry.toolName || "Tool";
  const mcp = parseMcpTool(toolName);
  const summary = getSummary(toolName, entry.toolInput, entry.content);

  return (
    <div className="tool">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">{expanded ? "▾" : "▸"}</span>
        {mcp ? (
          <>
            <span className="tool-mcp-chip">{mcp.server}</span>
            <span className="tool-name">{mcp.tool}</span>
          </>
        ) : (
          <span className="tool-name">{toolName}</span>
        )}
        <span className="tool-summary">{summary}</span>
        {result && <span className="tool-ok">✓</span>}
      </div>
      {expanded && (
        <div className="tool-detail">
          <pre className="tool-pre">{formatInput(entry.toolInput)}</pre>
          {result && (result.content || result.images?.length) && (
            <>
              <div className="tool-result-divider">Output</div>
              {result.content && <pre className="tool-pre">{truncate(result.content, 2000)}</pre>}
              {result.images && result.images.length > 0 && (
                <div className="tool-result-images">
                  {result.images.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="md-image-link">
                      <img className="md-image" src={src} alt="" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function getSummary(toolName: string, input: unknown, fallback: string): string {
  if (!input || typeof input !== "object") return fallback;
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case "Read":
      return (inp.file_path as string) || fallback;
    case "Edit":
      return (inp.file_path as string) || fallback;
    case "Write":
      return (inp.file_path as string) || fallback;
    case "Bash":
      return truncate((inp.command as string) || fallback, 120);
    case "Grep":
      return `/${inp.pattern || ""}/ ${inp.path || ""}`;
    case "Glob":
      return `${inp.pattern || ""} ${inp.path || ""}`;
    case "Task":
    case "Agent":
      return [inp.subagent_type, inp.description].filter(Boolean).join(": ") || fallback;
    case "Workflow":
      return (inp.name as string) || (inp.description as string) || "orchestration script";
    case "Skill":
      return (inp.skill as string) || fallback;
    case "WebFetch":
    case "WebSearch":
      return (inp.url as string) || (inp.query as string) || fallback;
    default:
      return fallback;
  }
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}
