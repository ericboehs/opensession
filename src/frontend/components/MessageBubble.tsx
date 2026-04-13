import React, { useMemo } from "react";
import { marked } from "marked";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entry: TranscriptEntry;
}

export function MessageBubble({ entry }: Props) {
  const html = useMemo(() => {
    if (entry.type === "user") return null; // rendered as plain text
    try {
      return marked.parse(entry.content, { async: false }) as string;
    } catch {
      return entry.content;
    }
  }, [entry.content, entry.type]);

  if (entry.type === "system") {
    return (
      <div className="message-bubble message-system">
        <em>{entry.content}</em>
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="message-bubble message-user">
        <div className="message-content">{entry.content}</div>
        <div className="message-time">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="message-bubble message-assistant">
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
