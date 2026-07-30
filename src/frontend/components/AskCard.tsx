import { useState } from "react";
import { AGENT_NAME } from "../lib/brand";
import { renderMarkdown } from "../lib/markdown";
import type { AskQuestion } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";

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
    <div className="mx-auto mb-6 mt-2 flex w-full max-w-[var(--chat-col)] flex-col gap-3 rounded-[calc(22px*var(--rf))] bg-raised p-3 shadow-[0_1px_2px_rgba(0,0,0,0.05)] [corner-shape:var(--cs)] sm:p-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex min-h-7 items-center gap-2 rounded-full bg-panel px-2.5 py-1 text-xs font-semibold text-fg">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
          />
          {AGENT_NAME} needs input
        </span>
      </div>

      {questions.map((q) => (
        <section
          key={q.question}
          className="rounded-[calc(16px*var(--rf))] bg-panel p-3.5 [corner-shape:var(--cs)] sm:p-4"
        >
          {q.header && (
            <div className="mb-1.5 text-xs font-semibold text-faint">{q.header}</div>
          )}
          <div
            className="markdown text-[14px] leading-[1.45] text-fg [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(q.question) }}
          />
          {q.options?.length ? (
            <div
              aria-label={q.header || "Answer options"}
              className="mt-3 flex flex-col gap-2"
              role="group"
            >
              {q.options.map((opt) => {
                const active = (selected[q.question] || []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      "group flex min-h-11 w-full items-center gap-3 rounded-[calc(13px*var(--rf))] px-3 text-left transition-[background-color,box-shadow] focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] [corner-shape:var(--cs)]",
                      active
                        ? "bg-accent-soft text-fg"
                        : "bg-raised text-fg hover:bg-hover",
                    )}
                    onClick={() => toggle(q, opt.label)}
                    disabled={submitted}
                    title={opt.description}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold leading-5">{opt.label}</span>
                      {opt.description && (
                        <span className="mt-0.5 block text-xs leading-[1.4] text-dim">
                          {opt.description}
                        </span>
                      )}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-[background-color,color]",
                        active
                          ? "bg-accent text-white"
                          : "bg-pressed text-transparent",
                      )}
                    >
                      <IconCheck size={20} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <input
            aria-label={q.options?.length ? "Custom answer" : "Answer"}
            className="mt-3 h-11 w-full rounded-[calc(13px*var(--rf))] bg-raised px-3.5 text-base text-fg outline-none transition-shadow placeholder:text-faint focus:shadow-[0_0_0_3px_var(--accent-soft)] sm:text-sm [corner-shape:var(--cs)]"
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
        </section>
      ))}

      <div className="flex justify-end">
        <Button
          variant="primary"
          className="min-h-10 rounded-[calc(13px*var(--rf))] px-4 text-sm [corner-shape:var(--cs)]"
          onClick={submit}
          disabled={!complete || submitted}
        >
          {submitted ? "Sent" : "Answer"}
        </Button>
      </div>
    </div>
  );
}
