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
      <div className="message-bubble message-system">
        <em>{entry.content}</em>
      </div>
    );
  }

  const className = entry.type === "user" ? "message-user" : "message-assistant";

  return (
    <div className={`message-bubble ${className}`}>
      <div
        className="message-content markdown"
        dangerouslySetInnerHTML={{ __html: html || "" }}
      />
      <div className="message-time">
        {new Date(entry.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}
