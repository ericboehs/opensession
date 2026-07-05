import React, { useEffect, useRef, useState } from "react";
import type { UnifiedSession, WSServerMessage } from "../lib/types";
import {
  fetchModels,
  fetchFileMentions,
  fetchSkillMentions,
  fetchHumanAsks,
  nudgeHumanAsk,
  cancelHumanAsk,
  relativeTime,
  type ModelOption,
  type HumanAskView,
} from "../lib/api";
import { useCurrentUser } from "./UserPicker";
import { Composer } from "./Composer";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";

interface Props {
  sessions: UnifiedSession[];
  connected: boolean;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  onSelect: (session: UnifiedSession) => void;
  onNewSession: (prompt?: string) => void;
  onOpenReviews: () => void;
  onOpenSessionId?: (id: string) => void;
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
    chip: "grafana",
    color: "#f48f57",
    prompt: "How healthy is the recording flow right now? Check completion rate, upload failures and encoder errors in Grafana.",
  },
  {
    chip: "grafana",
    color: "#f48f57",
    prompt: "Any failed renders or exports in the last 24 hours? Check the render metrics and Temporal worker logs in Grafana.",
  },
  {
    chip: "grafana",
    color: "#f48f57",
    prompt: "How is the webapp doing — any 5xx spikes, cold starts or slow routes on tella.tv? Check the Vercel logs in Grafana.",
  },
  {
    chip: "codebase",
    color: "#e3b341",
    prompt: "Explain how the video export pipeline works end to end — from clicking Export to the final file.",
  },
];

// A rotating handful keeps the start screen calm; at most one per source so a
// single integration (grafana has three prompts) can't dominate the row.
function sampleSuggestions(count: number) {
  const shuffled = [...SUGGESTIONS].sort(() => Math.random() - 0.5);
  const seen = new Set<string>();
  const picked = shuffled.filter((s) => !seen.has(s.chip) && seen.add(s.chip) !== undefined);
  return picked.slice(0, count);
}

function timeGreeting(user: string) {
  const h = new Date().getHours();
  const part = h < 6 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return user !== "Anonymous" ? `${part}, ${user}` : part;
}

/**
 * "Waiting on teammates" — open human asks (questions Michael sent to people
 * over Slack and is still waiting on). Renders nothing when there are none,
 * keeping the home hero calm.
 */
function HumanAsksCard({ onOpenSessionId }: { onOpenSessionId?: (id: string) => void }) {
  const [asks, setAsks] = useState<HumanAskView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchHumanAsks()
        .then((a) => alive && setAsks(a))
        .catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (asks.length === 0) return null;

  return (
    <div className="w-full max-w-[640px] mx-auto mt-6 text-left bg-panel border border-line rounded-panel px-4 py-3">
      <div className="text-dim text-[12px] font-medium uppercase tracking-wide mb-2">
        Waiting on teammates
      </div>
      <div className="flex flex-col gap-2">
        {asks.map((a) => (
          <div key={a.id} className="flex items-baseline gap-2 min-w-0 text-[13px]">
            <span className="text-fg shrink-0 font-medium">{a.person.name}</span>
            <span className="text-dim truncate" title={a.question}>
              {a.question}
            </span>
            <span className="text-faint text-[11.5px] shrink-0 ml-auto" title={a.createdAt}>
              {a.state === "scheduled" ? "queued" : relativeTime(a.deliveredAt || a.createdAt)}
            </span>
            {a.state === "delivered" && (
              <button
                className="btn-small shrink-0"
                disabled={busy === a.id}
                onClick={async () => {
                  setBusy(a.id);
                  try {
                    await nudgeHumanAsk(a.id);
                  } catch {}
                  setBusy(null);
                }}
                title="Send a friendly reminder in the Slack thread"
              >
                Nudge
              </button>
            )}
            <button
              className="btn-small shrink-0"
              disabled={busy === a.id}
              onClick={async () => {
                setBusy(a.id);
                try {
                  await cancelHumanAsk(a.id);
                  setAsks(asks.filter((x) => x.id !== a.id));
                } catch {}
                setBusy(null);
              }}
              title="Cancel the ask (the session stops waiting)"
            >
              ✕
            </button>
            {onOpenSessionId && (
              <button
                className="btn-small shrink-0"
                onClick={() => onOpenSessionId(a.sessionId)}
                title="Open the session that asked"
              >
                →
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Home({ sessions, connected, send, addHandler, onSelect, onNewSession, onOpenReviews, onOpenSessionId }: Props) {
  // Seeded from / mirrored into the draft store so wandering off to a chat or
  // workspace and back doesn't lose a half-typed question.
  const [question, setQuestion] = useState(() => loadDraft("home").text);
  useEffect(() => {
    saveDraft("home", { text: question });
  }, [question]);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // Mirror of `asking` readable from the (stable) WS handler below.
  const askingRef = useRef(false);
  useEffect(() => {
    askingRef.current = asking;
  }, [asking]);
  const askTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [askModel, setAskModel] = useState(""); // "" = default
  const [suggestions] = useState(() => sampleSuggestions(5));
  const currentUser = useCurrentUser();

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  // Success navigates away on session_created (App handles it), so on failure
  // the `asking` lock would stick forever: reset it on a server error, and as a
  // last resort on a timeout (e.g. the socket silently dropped the send).
  useEffect(() => {
    return addHandler((msg) => {
      if (msg.type === "error" && askingRef.current) {
        clearTimeout(askTimer.current);
        setAsking(false);
        setAskError(msg.message || "Failed to start the session.");
      } else if (msg.type === "session_created" && askingRef.current) {
        // The question was consumed — drop the stored draft so it doesn't
        // resurface next time Home mounts. (App navigates us away right after.)
        clearDraft("home");
      }
    });
  }, [addHandler]);
  useEffect(() => () => clearTimeout(askTimer.current), []);

  function handleAsk() {
    const q = question.trim();
    if (!q || asking || !connected) return;
    setAsking(true);
    // Synchronously too — session_created is announced before the worktree even
    // boots, so it can arrive before the effect mirrors `asking` into the ref,
    // and the handler above would then skip the draft clear.
    askingRef.current = true;
    setAskError(null);
    clearTimeout(askTimer.current);
    askTimer.current = setTimeout(() => {
      if (!askingRef.current) return;
      setAsking(false);
      setAskError("Michael didn't respond — check the connection and try again.");
    }, 15_000);
    send({
      type: "create_session",
      mode: "ask",
      branch: "",
      prompt: q,
      user: currentUser,
      // Every chat lives in a workspace from birth — the ask box creates one
      // too, so later sibling chats (+ in the tab strip) link up properly.
      createWorkspace: {},
      ...(askModel ? { model: askModel } : {}),
    });
    // App navigates into the session on session_created
  }

  const isPhone =
    typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;

  // Ambient status whisper — counts only, no lists; the sidebar has the lists.
  const active = sessions.filter((s) => !s.archived);
  const running = active.filter((s) => s.isRunning);
  const waiting = active.filter(
    (s) => (s.waitingForInput || s.lastRunError) && !s.isRunning,
  );
  const openPrs = new Set(
    active.filter((s) => s.prUrl && s.prState === "OPEN").map((s) => s.prUrl),
  ).size;

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <div className="home-hello">{timeGreeting(currentUser)}</div>
          <div className="home-greeting">What should Michael work on?</div>
          <Composer
            value={question}
            onChange={setQuestion}
            onSend={handleAsk}
            placeholder="Ask about the codebase…"
            disabled={asking}
            sendDisabled={asking || !connected || !question.trim()}
            sendTitle="Ask (Enter)"
            models={models}
            defaultModel={defaultModel}
            model={askModel}
            onModelChange={setAskModel}
            modelTitle="Model for this Ask session"
            mentionFetch={(q) => fetchFileMentions(q)}
            skillsFetch={(q) => fetchSkillMentions(q)}
            autoFocus={!isPhone}
            leftExtra={
              <button
                className="btn-task"
                onClick={() => {
                  const q = question.trim();
                  onNewSession(q || undefined);
                  // The palette takes ownership of the text (it lands in its own
                  // "new-session" draft via the prefill) — clear it here so it
                  // doesn't linger on Home and re-prefill the next palette after
                  // the session is created (Kent's stale-draft report).
                  if (q) setQuestion("");
                }}
                disabled={asking}
              >
                {isPhone ? "Code task" : "Start a coding task"}
              </button>
            }
          />
          {askError && <div className="ask-error">{askError}</div>}

          <div className="ask-suggestions">
            {suggestions.map((s, i) => (
              <button
                key={`${s.chip}-${i}`}
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

          {(running.length > 0 || waiting.length > 0 || openPrs > 0) && (
            <div className="home-whisper">
              {running.length > 0 && (
                <span className="home-whisper-part">
                  <span className="working-dot" />
                  {running.length} running
                </span>
              )}
              {waiting.length > 0 && (
                <button
                  className="home-whisper-part home-whisper-link"
                  onClick={() => onSelect(waiting[0])}
                  title={waiting[0].title}
                >
                  {waiting.length} waiting for input
                </button>
              )}
              {openPrs > 0 && (
                <button className="home-whisper-part home-whisper-link" onClick={onOpenReviews}>
                  {openPrs} PR{openPrs === 1 ? "" : "s"} to review
                </button>
              )}
            </div>
          )}

          <HumanAsksCard onOpenSessionId={onOpenSessionId} />
        </div>
      </div>
    </div>
  );
}
