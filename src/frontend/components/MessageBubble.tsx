import React, { useMemo } from "react";
import { marked } from "marked";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entry: TranscriptEntry;
}

export function MessageBubble({ entry }: Props) {
  const html = useMemo(() => {
    try {
      return marked.parse(entry.content, { async: false, breaks: true }) as string;
    } catch {
      return entry.content;
    }
  }, [entry.content]);

  if (entry.type === "system") {
    return (
      <div className="cc-system">
        {entry.content}
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="cc-user">
        <span className="cc-user-prompt">❯</span>
        <div className="cc-user-text">{entry.content}</div>
      </div>
    );
  }

  // assistant
  return (
    <div className="cc-assistant">
      <div
        className="cc-assistant-text markdown"
        dangerouslySetInnerHTML={{ __html: html || "" }}
      />
    </div>
  );
}
