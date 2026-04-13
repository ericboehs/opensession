import React, { useState } from "react";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
}

export function ToolCallBlock({ entry, result }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-call-block">
      <div
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-call-chevron">{expanded ? "▼" : "▶"}</span>
        <span className="tool-call-name">{entry.toolName || "Tool"}</span>
        <span className="tool-call-summary">{entry.content}</span>
      </div>
      {expanded && (
        <div className="tool-call-detail">
          <div className="tool-call-input">
            <pre>{formatInput(entry.toolInput)}</pre>
          </div>
          {result && (
            <div className="tool-call-result">
              <div className="tool-call-result-label">Result:</div>
              <pre>{truncate(result.content, 1000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n... (truncated)";
}
