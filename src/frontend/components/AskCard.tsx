import { AGENT_NAME } from "../lib/brand";
import React, { useState } from "react";
import type { AskQuestion } from "../lib/types";

interface Props {
  questions: AskQuestion[];
  onAnswer: (answers: Record<string, string>) => void;
}

/** Interactive AskUserQuestion card — the agent is waiting on these answers. */
export function AskCard({ questions, onAnswer }: Props) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  function toggle(q: AskQuestion, label: string) {
    setSelected((prev) => {
      const current = prev[q.question] || [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.question]: current.includes(label)
            ? current.filter((l) => l !== label)
            : [...current, label],
        };
      }
      return { ...prev, [q.question]: [label] };
    });
  }

  function answerFor(q: AskQuestion): string | null {
    const custom = (other[q.question] || "").trim();
    const picks = selected[q.question] || [];
    const parts = [...picks, ...(custom ? [custom] : [])];
    return parts.length > 0 ? parts.join(", ") : null;
  }

  const complete = questions.every((q) => answerFor(q) !== null);

  function submit() {
    if (!complete || submitted) return;
    setSubmitted(true);
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q)!;
    onAnswer(answers);
  }

  return (
    <div className="ask-card">
      <div className="ask-card-title">
        <span className="working-dot" /> {AGENT_NAME} needs input
      </div>

      {questions.map((q) => (
        <div key={q.question} className="ask-card-question">
          {q.header && <div className="ask-card-header">{q.header}</div>}
          <div className="ask-card-text">{q.question}</div>
          {q.options?.length ? (
            <div className="ask-card-options">
              {q.options.map((opt) => {
                const active = (selected[q.question] || []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    className={`ask-card-option ${active ? "active" : ""}`}
                    onClick={() => toggle(q, opt.label)}
                    disabled={submitted}
                    title={opt.description}
                  >
                    <span className="ask-card-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="ask-card-option-desc">{opt.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
          <input
            className="ask-card-other"
            placeholder={
              q.options?.length ? "Or type your own answer…" : "Type your answer…"
            }
            value={other[q.question] || ""}
            onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={submitted}
          />
        </div>
      ))}

      <div className="ask-card-actions">
        <button className="btn-send" onClick={submit} disabled={!complete || submitted}>
          {submitted ? "Sent…" : "Answer"}
        </button>
      </div>
    </div>
  );
}
