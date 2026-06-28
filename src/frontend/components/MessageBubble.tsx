import React, { useMemo } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";

interface Props {
  entry: TranscriptEntry;
  /** When provided, assistant messages show a "Fork from here" action. */
  onFork?: (entryId: string) => void;
}

/** Inline images carried on an entry (Read-of-image results, pasted images). */
function EntryImages({ images }: { images?: string[] }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="msg-images">
      {images.map((src, i) => (
        <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="md-image-link">
          <img className="md-image" src={src} alt="" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export function MessageBubble({ entry, onFork }: Props) {
  const html = useMemo(() => renderMarkdown(entry.content), [entry.content]);

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
        {entry.content && (
          <div
            className="msg-body msg-body-user markdown"
            dangerouslySetInnerHTML={{ __html: html || "" }}
          />
        )}
        <EntryImages images={entry.images} />
      </div>
    );
  }

  // assistant
  return (
    <div className="msg msg-assistant">
      <div className="msg-label msg-label-assistant">
        Michael
        {onFork && (
          <button
            className="msg-fork-btn"
            onClick={() => onFork(entry.id)}
            title="Fork a new session that branches from this point, keeping the conversation so far"
          >
            ⑂ Fork from here
          </button>
        )}
      </div>
      <div
        className="msg-body msg-body-assistant markdown"
        dangerouslySetInnerHTML={{ __html: html || "" }}
      />
      <EntryImages images={entry.images} />
    </div>
  );
}
