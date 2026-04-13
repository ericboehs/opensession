import React, { useEffect, useRef, useState } from "react";
import type { UnifiedSession, TranscriptEntry, WSServerMessage } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { ToolCallBlock } from "./ToolCallBlock";
import { getCurrentUser } from "./UserPicker";
import { deleteSessionApi } from "../lib/api";

interface Props {
  session: UnifiedSession;
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
}

export function SessionViewer({ session, onBack, send, addHandler, connected }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to WebSocket messages
  useEffect(() => {
    if (!connected) return;

    send({ type: "watch", sessionId: session.id });

    const unsubscribe = addHandler((msg) => {
      switch (msg.type) {
        case "transcript_init":
          setEntries(msg.entries);
          setLoading(false);
          break;
        case "transcript_append":
          setEntries((prev) => [...prev, ...msg.entries]);
          break;
        case "stream_start":
          setIsStreaming(true);
          setStreamText("");
          break;
        case "stream_text":
          setStreamText((prev) => prev + msg.text);
          break;
        case "stream_tool_use":
          setEntries((prev) => [...prev, msg.entry]);
          break;
        case "stream_tool_result":
          setEntries((prev) => [...prev, msg.entry]);
          break;
        case "stream_done":
          setIsStreaming(false);
          if (streamText) {
            // The final text will come through transcript_append from file watcher
          }
          setStreamText("");
          break;
        case "error":
          setIsStreaming(false);
          break;
      }
    });

    return unsubscribe;
  }, [session.id, connected]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, streamText]);

  function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    send({
      type: "prompt",
      sessionId: session.id,
      content: text,
    });
    setInput("");
  }

  function handleCancel() {
    send({ type: "cancel" });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  }

  // Build tool_use → tool_result map
  const toolResults = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_result" && e.toolUseId) {
      toolResults.set(e.toolUseId, e);
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isBusy = session.isRunning || isStreaming;
  const canSend = connected && !isBusy && session.transcriptPath;

  async function handleDelete(cleanWorktree: boolean) {
    setDeleting(true);
    try {
      await deleteSessionApi(session.id, cleanWorktree);
      onBack();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  const prClass = session.prState === "MERGED"
    ? "session-link-pr-merged"
    : session.prState === "CLOSED"
      ? "session-link-pr-closed"
      : "session-link-pr";

  return (
    <div className="session-viewer">
      <div className="viewer-header">
        <button className="btn-back" onClick={onBack}>
          ← Back
        </button>
        <div className="viewer-title">
          <span
            className="source-badge"
            style={{
              backgroundColor:
                session.source === "slack"
                  ? "#4A154B"
                  : session.source === "linear"
                    ? "#5E6AD2"
                    : "#0D9488",
            }}
          >
            {session.source}
          </span>
          <span className="viewer-branch">{session.title}</span>
          {isBusy && <span className="streaming-indicator">● Running</span>}
        </div>
        <div className="viewer-header-actions">
          {session.prUrl && (
            <a href={session.prUrl} target="_blank" rel="noopener" className={`session-link ${prClass}`}>
              PR {session.prState === "MERGED" ? "✓" : ""}
            </a>
          )}
          {session.linearIssue?.url && (
            <a href={session.linearIssue.url} target="_blank" rel="noopener" className="session-link session-link-linear">
              {session.linearIssue.identifier}
            </a>
          )}
          {!showDeleteConfirm ? (
            <button
              className="btn-viewer-delete"
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session"
            >
              Delete
            </button>
          ) : (
            <div className="viewer-delete-confirm">
              {session.worktreeDir && (
                <button className="btn-delete-wt" onClick={() => handleDelete(true)} disabled={deleting}>
                  {deleting ? "..." : "+ Worktree"}
                </button>
              )}
              <button className="btn-delete-only" onClick={() => handleDelete(false)} disabled={deleting}>
                {deleting ? "..." : "Session"}
              </button>
              <button className="btn-delete-cancel" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="viewer-messages">
        {loading ? (
          <div className="loading">Loading transcript...</div>
        ) : entries.length === 0 && !session.transcriptPath ? (
          <div className="empty">No transcript available for this session</div>
        ) : entries.length === 0 ? (
          <div className="empty">Empty transcript</div>
        ) : (
          entries.map((entry) => {
            if (entry.type === "tool_use") {
              return (
                <ToolCallBlock
                  key={entry.id}
                  entry={entry}
                  result={entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined}
                />
              );
            }
            if (entry.type === "tool_result") {
              return null; // rendered inside ToolCallBlock
            }
            return <MessageBubble key={entry.id} entry={entry} />;
          })
        )}

        {streamText && (
          <div className="message-bubble message-assistant streaming">
            <div className="message-content">{streamText}</div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="viewer-input">
        {isBusy ? (
          <div className="input-busy">
            <span className="pulse-dot" /> Claude is working...
            <button className="btn-cancel" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        ) : !session.claudeSessionId ? (
          <div className="input-disabled">
            No Claude session to resume
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className="prompt-input"
              placeholder={canSend ? "Send a prompt... (⌘+Enter)" : "Not connected"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!canSend}
              rows={2}
            />
            <button
              className="btn-send"
              onClick={handleSend}
              disabled={!canSend || !input.trim()}
            >
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
