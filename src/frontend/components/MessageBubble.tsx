import React, { useMemo } from "react";
import type { TranscriptEntry } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { parseHumanReply, parseAttribution } from "../lib/humanReply";
import { useCurrentUser } from "./UserPicker";

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
  const me = useCurrentUser();
  // A routed-back teammate reply (human-in-the-loop): credit the teammate and
  // render just their words (the header is stripped — the label carries "who").
  const humanReply = useMemo(() => {
    if (entry.type !== "user") return null;
    const parsed = parseHumanReply(entry.content);
    return parsed ? { name: parsed.name, html: renderMarkdown(parsed.body) } : null;
  }, [entry.type, entry.content]);
  // A "[Name] …" attributed turn: a named teammate steered/sent into this
  // session. It's the driver, so it keeps a normal user bubble — but credited
  // to the sender (and the prefix stripped). When the sender is the viewer it
  // stays "You"; only the body changes (prefix removed).
  const attribution = useMemo(() => {
    if (entry.type !== "user" || humanReply) return null;
    return parseAttribution(entry.content);
  }, [entry.type, entry.content, humanReply]);
  const displayContent = attribution ? attribution.body : entry.content;
  const html = useMemo(() => renderMarkdown(displayContent), [displayContent]);

  if (entry.type === "system") {
    return (
      <div className="msg msg-system">
        <span className="msg-system-text">{entry.content}</span>
      </div>
    );
  }

  if (entry.type === "user" && humanReply) {
    return (
      <div className="msg msg-human">
        <div className="msg-label msg-label-human">💬 {humanReply.name} · via Slack</div>
        <div
          className="msg-body msg-body-human markdown"
          dangerouslySetInnerHTML={{ __html: humanReply.html || "" }}
        />
        <EntryImages images={entry.images} />
      </div>
    );
  }

  if (entry.type === "user") {
    // Credit a named teammate who drove this session; "You" only when the
    // sender is the current viewer (or the turn carries no attribution).
    const fromOther = attribution && attribution.name !== me ? attribution.name : null;
    return (
      <div className="msg msg-user">
        <div className="msg-label msg-label-user">{fromOther || "You"}</div>
        {displayContent && (
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
