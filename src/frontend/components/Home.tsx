import React, { useEffect, useState } from "react";
import { fetchModels, fetchFileMentions, type ModelOption } from "../lib/api";
import { useCurrentUser } from "./UserPicker";
import { Composer } from "./Composer";

interface Props {
  connected: boolean;
  send: (msg: any) => void;
  onNewSession: (prompt?: string) => void;
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

export function Home({ connected, send, onNewSession }: Props) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
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
      // Every chat lives in a workspace from birth — the ask box creates one
      // too, so later sibling chats (+ in the tab strip) link up properly.
      createWorkspace: {},
      ...(askModel ? { model: askModel } : {}),
    });
    // App navigates into the session on session_created
  }

  const isPhone =
    typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;

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
            placeholder="Ask a question about the codebase — Michael answers without touching anything…"
            disabled={asking}
            sendDisabled={asking || !connected || !question.trim()}
            sendTitle="Ask (Enter)"
            models={models}
            defaultModel={defaultModel}
            model={askModel}
            onModelChange={setAskModel}
            modelTitle="Model for this Ask session"
            mentionFetch={(q) => fetchFileMentions(q)}
            autoFocus={!isPhone}
            leftExtra={
              <button
                className="btn-task"
                onClick={() => onNewSession(question.trim() || undefined)}
                disabled={asking}
              >
                {isPhone ? "Code task" : "Start a coding task"}
              </button>
            }
          />

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
        </div>
      </div>
    </div>
  );
}
