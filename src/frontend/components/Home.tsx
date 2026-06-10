import React, { useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";
import { sessionStatus } from "../lib/status";
import { getPins, togglePin } from "../lib/pins";
import { getCurrentUser } from "./UserPicker";

interface Props {
  sessions: UnifiedSession[];
  loading: boolean;
  connected: boolean;
  send: (msg: any) => void;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
}

export function Home({ sessions, loading, connected, send, onSelect, onNewSession }: Props) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [pins, setPins] = useState<string[]>(() => getPins());

  function handleAsk() {
    const q = question.trim();
    if (!q || asking || !connected) return;
    setAsking(true);
    send({
      type: "create_session",
      mode: "ask",
      branch: "",
      prompt: q,
      user: getCurrentUser(),
    });
    // App navigates into the session on session_created
  }

  function handlePin(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setPins(togglePin(id));
  }

  const running = sessions.filter((s) => s.isRunning);
  const pinned = sessions.filter((s) => pins.includes(s.id) && !s.isRunning);
  const recent = sessions
    .filter((s) => !s.isRunning && !pins.includes(s.id))
    .slice(0, 12);

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <div className="home-greeting">
            What should Michael work on{getCurrentUser() !== "Anonymous" ? `, ${getCurrentUser()}` : ""}?
          </div>
          <div className="ask-box">
            <textarea
              className="ask-input"
              placeholder="Ask a question about the codebase — Michael answers without touching anything…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleAsk();
                }
              }}
              rows={2}
              disabled={asking}
            />
            <div className="ask-actions">
              <button className="btn-task" onClick={onNewSession} disabled={asking}>
                Start a coding task
              </button>
              <button
                className="btn-ask"
                onClick={handleAsk}
                disabled={asking || !connected || !question.trim()}
              >
                {asking ? "Starting…" : "Ask"}
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="loading">Loading sessions…</div>
        ) : (
          <>
            {running.length > 0 && (
              <Section title="Working now">
                {running.map((s) => (
                  <SessionRow key={s.id} session={s} pinned={pins.includes(s.id)} onPin={handlePin} onClick={() => onSelect(s)} />
                ))}
              </Section>
            )}

            {pinned.length > 0 && (
              <Section title="Pinned">
                {pinned.map((s) => (
                  <SessionRow key={s.id} session={s} pinned onPin={handlePin} onClick={() => onSelect(s)} />
                ))}
              </Section>
            )}

            <Section title="Recent">
              {recent.length === 0 ? (
                <div className="home-empty">No sessions yet — ask a question or start a task.</div>
              ) : (
                recent.map((s) => (
                  <SessionRow key={s.id} session={s} pinned={false} onPin={handlePin} onClick={() => onSelect(s)} />
                ))
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="home-section">
      <div className="home-section-title">{title}</div>
      <div className="home-rows">{children}</div>
    </div>
  );
}

function SessionRow({
  session,
  pinned,
  onPin,
  onClick,
}: {
  session: UnifiedSession;
  pinned: boolean;
  onPin: (e: React.MouseEvent, id: string) => void;
  onClick: () => void;
}) {
  const status = sessionStatus(session);
  const chip = session.mode === "ask" ? "ask" : session.source;

  return (
    <button className="home-row" onClick={onClick}>
      <span className={`status-pill status-${status.tone}`}>
        {status.tone === "green" && <span className="working-dot" />}
        {status.label}
      </span>
      <span className="home-row-main">
        <span className="home-row-title">{session.title}</span>
        <span className="home-row-meta">
          <span className={`source-chip source-${chip}`}>{chip}</span>
          {session.branch && session.branch !== session.title && (
            <span className="home-row-branch">{session.branch}</span>
          )}
          {session.startedBy && <span>{session.startedBy}</span>}
          <span>{relativeTime(session.lastActivity)}</span>
        </span>
      </span>
      <span
        className={`pin-btn ${pinned ? "pin-active" : ""}`}
        onClick={(e) => onPin(e, session.id)}
        title={pinned ? "Unpin" : "Pin"}
        role="button"
      >
        {pinned ? "★" : "☆"}
      </span>
    </button>
  );
}
