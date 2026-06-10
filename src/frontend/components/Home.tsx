import React, { useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";
import { sessionStatus } from "../lib/status";
import { getPins, togglePin } from "../lib/pins";
import { useCurrentUser } from "./UserPicker";

interface Props {
  sessions: UnifiedSession[];
  loading: boolean;
  connected: boolean;
  send: (msg: any) => void;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
}

const SUGGESTIONS: Array<{ chip: string; color: string; prompt: string }> = [
  {
    chip: "tinybird",
    color: "#27F795",
    prompt: "How many recordings were created this week vs last week? Break it down by day using Tinybird.",
  },
  {
    chip: "sentry",
    color: "#a38fd8",
    prompt: "What are the top unresolved Sentry errors in production right now? Flag anything that started in the last 48 hours.",
  },
  {
    chip: "plain",
    color: "#5eead4",
    prompt: "Summarize today's Plain support tickets — any recurring themes or bugs we should look into?",
  },
  {
    chip: "linear",
    color: "#7b86e8",
    prompt: "What shipped this week and what's still in progress in Linear? Short digest please.",
  },
  {
    chip: "workos",
    color: "#9da6ee",
    prompt: "Any notable new organizations in WorkOS this week? List name, plan and member count.",
  },
  {
    chip: "codebase",
    color: "#e3b341",
    prompt: "Explain how the video export pipeline works end to end — from clicking Export to the final file.",
  },
];

export function Home({ sessions, loading, connected, send, onSelect, onNewSession }: Props) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [pins, setPins] = useState<string[]>(() => getPins());
  const currentUser = useCurrentUser();

  function handleAsk() {
    const q = question.trim();
    if (!q || asking || !connected) return;
    setAsking(true);
    send({
      type: "create_session",
      mode: "ask",
      branch: "",
      prompt: q,
      user: currentUser,
    });
    // App navigates into the session on session_created
  }

  function handlePin(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setPins(togglePin(id));
  }

  const visible = sessions.filter((s) => !s.archived);
  const running = visible.filter((s) => s.isRunning);
  const pinned = visible.filter((s) => pins.includes(s.id) && !s.isRunning);
  const recent = visible
    .filter((s) => !s.isRunning && !pins.includes(s.id))
    .slice(0, 12);

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <div className="home-greeting">
            What should Michael work on{currentUser !== "Anonymous" ? `, ${currentUser}` : ""}?
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

          <div className="ask-suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.chip}
                className="ask-suggestion"
                onClick={() => setQuestion(s.prompt)}
                disabled={asking}
                title={s.prompt}
              >
                <span className="ask-suggestion-dot" style={{ backgroundColor: s.color }} />
                {s.prompt.split("?")[0].split("—")[0].slice(0, 52)}
                {s.prompt.length > 52 ? "…" : ""}
              </button>
            ))}
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
