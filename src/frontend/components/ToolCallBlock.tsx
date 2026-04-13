import React, { useState } from "react";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

export function ToolCallBlock({ entry, result }: Props) {
  const [expanded, setExpanded] = useState(false);
  const toolName = entry.toolName || "Tool";
  const summary = getSummary(toolName, entry.toolInput, entry.content);

  return (
    <div className="cc-tool">
      <div
        className="cc-tool-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="cc-tool-prefix">⎿</span>
        <span className="cc-tool-name">{toolName}</span>
        <span className="cc-tool-summary">{summary}</span>
        {result && <span className="cc-tool-check">✓</span>}
      </div>
      {expanded && (
        <div className="cc-tool-detail">
          <pre className="cc-tool-pre">{formatInput(entry.toolInput)}</pre>
          {result && (
            <>
              <div className="cc-tool-result-label">Output</div>
              <pre className="cc-tool-pre">{truncate(result.content, 2000)}</pre>
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
      return (inp.description as string) || fallback;
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
