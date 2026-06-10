import React, { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { UnifiedSession, TranscriptEntry, WSServerMessage } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { WorkBlock } from "./WorkBlock";
import { TerminalPanel } from "./TerminalPanel";
import { getCurrentUser } from "./UserPicker";
import { deleteSessionApi } from "../lib/api";
import { DiffPanel } from "./DiffPanel";
import { PrPanel } from "./PrPanel";
import { SpinOffMenu } from "./SpinOffMenu";

interface Props {
  session: UnifiedSession;
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
}

type PanelTab = "changes" | "terminal" | "pr";

type RenderBlock =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "work"; items: TranscriptEntry[] };

/** Upsert incoming entries by id so stream events and the file watcher never duplicate. */
function mergeEntries(prev: TranscriptEntry[], incoming: TranscriptEntry[]): TranscriptEntry[] {
  if (incoming.length === 0) return prev;
  const indexById = new Map(prev.map((e, i) => [e.id, i] as const));
  const next = [...prev];
  for (const entry of incoming) {
    const idx = indexById.get(entry.id);
    if (idx !== undefined) {
      next[idx] = entry;
    } else {
      indexById.set(entry.id, next.length);
      next.push(entry);
    }
  }
  return next;
}

export function SessionViewer({ session, onBack, send, addHandler, connected }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isRunningLive, setIsRunningLive] = useState(session.isRunning);
  const [streamText, setStreamText] = useState("");
  const [streamBy, setStreamBy] = useState<string | null>(null);
  const [viewers, setViewers] = useState<string[]>([]);
  const [panelTab, setPanelTab] = useState<PanelTab>("changes");
  // On phones the panel overlays the chat, so start closed there
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 920
  );
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isAsk = session.mode === "ask";
  const hasWorkspace = !isAsk && Boolean(session.worktreeDir || session.branch);

  // Browser tab title follows the session
  useEffect(() => {
    document.title = `${session.title} — Michael`;
    return () => {
      document.title = "Michael — Tella";
    };
  }, [session.title]);

  // Subscribe to WebSocket messages
  useEffect(() => {
    if (!connected) return;

    send({ type: "watch", sessionId: session.id, user: getCurrentUser() });

    const unsubscribe = addHandler((msg) => {
      switch (msg.type) {
        case "transcript_init":
          setEntries(msg.entries);
          setLoading(false);
          break;
        case "transcript_append":
          setEntries((prev) => mergeEntries(prev, msg.entries));
          break;
        case "presence":
          if (msg.sessionId === session.id) setViewers(msg.viewers);
          break;
        case "session_status":
          setIsRunningLive(msg.isRunning);
          break;
        case "stream_start":
          setIsStreaming(true);
          setStreamBy(msg.by || null);
          setStreamText("");
          break;
        case "stream_text":
          setStreamText((prev) => prev + msg.text);
          break;
        case "stream_tool_use":
        case "stream_tool_result":
          setEntries((prev) => mergeEntries(prev, [msg.entry]));
          break;
        case "stream_done":
          setIsStreaming(false);
          setStreamBy(null);
          setStreamText("");
          break;
        case "error":
          setIsStreaming(false);
          break;
      }
    });

    return unsubscribe;
    // transcriptPath in deps: new sessions start without a transcript file —
    // re-watch once it appears so the live tail attaches
  }, [session.id, connected, session.transcriptPath]);

  // Auto-scroll, unless the reader has scrolled up to inspect history
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, streamText]);

  function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    send({
      type: "prompt",
      sessionId: session.id,
      content: text,
      user: getCurrentUser(),
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

  // Group consecutive tool calls into Devin-style work blocks
  const blocks: RenderBlock[] = [];
  for (const entry of entries) {
    if (entry.type === "tool_use") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "work") last.items.push(entry);
      else blocks.push({ kind: "work", items: [entry] });
    } else if (entry.type === "tool_result") {
      continue; // rendered inside work blocks via toolResults
    } else {
      blocks.push({ kind: "entry", entry });
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isBusy = isRunningLive || isStreaming;
  const canSend = connected && !isBusy && session.transcriptPath;
  const me = getCurrentUser();

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

  return (
    <div className="session-viewer">
      <div className="viewer-header">
        <div className="viewer-title">
          {isAsk ? (
            <span className="source-chip source-ask">ask</span>
          ) : (
            <span className={`source-chip source-${session.source}`}>{session.source}</span>
          )}
          <span className="viewer-branch" title={session.title}>{session.title}</span>
          {session.startedBy && (
            <span className="viewer-started-by">by {session.startedBy}</span>
          )}
          {session.archived && <span className="source-chip source-cli">archived</span>}
          {isBusy && (
            <span className="working-pill">
              <span className="working-dot" />
              {streamBy ? `Working for ${streamBy}` : "Working"}
            </span>
          )}
        </div>
        <div className="viewer-header-actions">
          {viewers.length > 1 && (
            <div className="presence" title={`Viewing: ${viewers.join(", ")}`}>
              {dedupeViewers(viewers).map((v) => (
                <span key={v.name} className={`presence-avatar ${v.name === me ? "presence-me" : ""}`}>
                  {v.name.charAt(0).toUpperCase()}
                  {v.count > 1 ? <span className="presence-count">{v.count}</span> : null}
                </span>
              ))}
            </div>
          )}
          {session.linearIssue?.url && (
            <a href={session.linearIssue.url} target="_blank" rel="noopener" className="session-link session-link-linear">
              {session.linearIssue.identifier}
            </a>
          )}
          {session.plainThreadId && (
            <a
              href={`https://app.plain.com/workspace/w_01J7WXJG68TFDV9RD1C4JE3W6F/thread/${session.plainThreadId}/`}
              target="_blank"
              rel="noopener"
              className="session-link session-link-plain"
            >
              Plain ↗
            </a>
          )}
          <SpinOffMenu session={session} entries={entries} send={send} connected={connected} />
          {hasWorkspace && (
            <button
              className={`btn-panel-toggle ${panelOpen ? "active" : ""}`}
              onClick={() => setPanelOpen(!panelOpen)}
              title="Toggle workspace panel"
            >
              ⫼
            </button>
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
              {session.worktreeDir && !isAsk && (
                <button className="btn-delete-wt" onClick={() => handleDelete(true)} disabled={deleting}>
                  {deleting ? "…" : "+ Worktree"}
                </button>
              )}
              <button className="btn-delete-only" onClick={() => handleDelete(false)} disabled={deleting}>
                {deleting ? "…" : "Session"}
              </button>
              <button className="btn-delete-cancel" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="viewer-split">
        <div className="viewer-chat">
          <div className="viewer-messages" ref={messagesRef}>
            {loading ? (
              <div className="loading">Loading transcript…</div>
            ) : entries.length === 0 && !session.transcriptPath ? (
              <div className="empty">No transcript available for this session</div>
            ) : entries.length === 0 ? (
              <div className="empty">Empty transcript</div>
            ) : (
              blocks.map((block, i) =>
                block.kind === "work" ? (
                  <WorkBlock
                    key={block.items[0].id}
                    items={block.items}
                    toolResults={toolResults}
                    live={isBusy && i === blocks.length - 1}
                  />
                ) : (
                  <MessageBubble key={block.entry.id} entry={block.entry} />
                )
              )
            )}

            {streamText && <StreamingMessage text={streamText} />}

            <div ref={bottomRef} />
          </div>

          <div className="viewer-input">
            {isBusy ? (
              <div className="input-busy">
                <span className="pulse-dot" />
                {streamBy && streamBy !== me ? `${streamBy} is driving — Michael is working…` : "Michael is working…"}
                <button className="btn-cancel" onClick={handleCancel}>
                  Cancel
                </button>
              </div>
            ) : !session.claudeSessionId ? (
              <div className="input-disabled">No Claude session to resume</div>
            ) : (
              <>
                <div className="viewer-input-row">
                  <textarea
                    ref={textareaRef}
                    className="prompt-input"
                    placeholder={canSend ? "Ask Michael to build, fix, or explain…" : "Not connected"}
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
                </div>
                <div className="prompt-hint">{"⌘"}+Enter to send</div>
              </>
            )}
          </div>
        </div>

        {hasWorkspace && panelOpen && (
          <div className="panel-overlay" onClick={() => setPanelOpen(false)} />
        )}
        {hasWorkspace && panelOpen && (
          <div className="viewer-panel">
            <div className="panel-tabs">
              <button
                className={`panel-tab ${panelTab === "changes" ? "active" : ""}`}
                onClick={() => setPanelTab("changes")}
              >
                Changes
              </button>
              <button
                className={`panel-tab ${panelTab === "terminal" ? "active" : ""}`}
                onClick={() => setPanelTab("terminal")}
              >
                Terminal
              </button>
              <button
                className={`panel-tab ${panelTab === "pr" ? "active" : ""}`}
                onClick={() => setPanelTab("pr")}
              >
                PR
                {session.prState && (
                  <span className={`panel-tab-dot pr-dot-${session.prState.toLowerCase()}`} />
                )}
              </button>
              {session.branch && <span className="panel-branch" title={session.branch}>{session.branch}</span>}
              <button
                className="panel-close"
                onClick={() => setPanelOpen(false)}
                aria-label="Close panel"
              >
                ✕
              </button>
            </div>
            <div className="panel-body">
              {panelTab === "changes" ? (
                <DiffPanel
                  sessionId={session.id}
                  isRunning={isBusy}
                  canSend={Boolean(canSend)}
                  send={send}
                />
              ) : panelTab === "terminal" ? (
                <TerminalPanel entries={entries} />
              ) : (
                <PrPanel sessionId={session.id} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StreamingMessage({ text }: { text: string }) {
  const html = React.useMemo(() => {
    try {
      return marked.parse(text, { async: false, breaks: true }) as string;
    } catch {
      return text;
    }
  }, [text]);

  return (
    <div className="msg msg-assistant msg-streaming">
      <div className="msg-label msg-label-assistant">Michael</div>
      <div
        className="msg-body msg-body-assistant markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function dedupeViewers(viewers: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of viewers) counts.set(v, (counts.get(v) || 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, count }));
}
