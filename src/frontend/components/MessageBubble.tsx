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
      <div className="msg msg-system">
        <span className="msg-system-text">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-label msg-label-user">You</div>
        <div className="msg-body msg-body-user">{entry.content}</div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg msg-assistant">
      <div className="msg-label msg-label-assistant">Claude</div>
      <div
        className="msg-body msg-body-assistant markdown"
        dangerouslySetInnerHTML={{ __html: html || "" }}
      />
    </div>
  );
}
