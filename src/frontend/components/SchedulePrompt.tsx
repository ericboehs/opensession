import React, { useEffect, useRef, useState } from "react";
import {
  fetchScheduledPrompts,
  createScheduledPromptApi,
  deleteScheduledPromptApi,
  type ScheduledPrompt,
} from "../lib/api";

/** "in 45m" / "in 3h" / "in 2d" for a future instant (short form). */
function inTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}
import { getCurrentUser } from "./UserPicker";

/**
 * Composer "send later": schedule a message for this session at a time. Due
 * prompts are delivered server-side through the normal prompt path (steer /
 * queue / fresh turn), so they behave exactly like typing at that moment.
 * Renders as a small clock button (with a count badge) + popover.
 */
export function SchedulePromptButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ScheduledPrompt[]>([]);
  const [text, setText] = useState("");
  const [at, setAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = () =>
    fetchScheduledPrompts(sessionId)
      .then(setPending)
      .catch(() => {});

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** datetime-local wants local time formatted YYYY-MM-DDTHH:MM. */
  function toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function quickPick(kind: "1h" | "evening" | "morning") {
    const d = new Date();
    if (kind === "1h") d.setHours(d.getHours() + 1);
    if (kind === "evening") {
      if (d.getHours() >= 18) d.setDate(d.getDate() + 1);
      d.setHours(18, 0, 0, 0);
    }
    if (kind === "morning") {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }
    setAt(toLocalInput(d));
  }

  async function handleSchedule() {
    if (!text.trim() || !at || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createScheduledPromptApi(sessionId, {
        prompt: text.trim(),
        at: new Date(at).toISOString(),
        user: getCurrentUser(),
      });
      setText("");
      setAt("");
      await load();
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        className="btn-task"
        onClick={() => setOpen(!open)}
        title="Schedule a message for later"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          style={{ verticalAlign: "-2px" }}
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8V8l2.2 1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {pending.length > 0 && <span className="ml-1">{pending.length}</span>}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 z-[200] w-[340px] bg-raised border border-line rounded-panel shadow-2xl p-3 flex flex-col gap-2">
          <div className="text-fg text-[13px] font-medium">Send later</div>

          {pending.length > 0 && (
            <div className="flex flex-col gap-1 border-b border-line pb-2">
              {pending.map((p) => (
                <div key={p.id} className="flex items-baseline gap-2 text-[12px] min-w-0">
                  <span
                    className="text-yellow shrink-0 font-medium"
                    title={new Date(p.at).toLocaleString()}
                  >
                    {inTime(p.at)}
                  </span>
                  <span className="text-dim truncate" title={p.prompt}>
                    {p.prompt}
                  </span>
                  <button
                    className="text-faint hover:text-red ml-auto shrink-0 cursor-pointer bg-transparent border-0 text-[12px]"
                    onClick={async () => {
                      try {
                        await deleteScheduledPromptApi(p.id);
                        load();
                      } catch {}
                    }}
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="What should Michael get told, and when?"
            className="w-full bg-surface border border-line rounded-md text-fg text-[13px] p-2 resize-y outline-none focus:border-line-strong"
          />

          <div className="flex items-center gap-1.5 flex-wrap">
            <button className="btn-small" onClick={() => quickPick("1h")}>
              in 1h
            </button>
            <button className="btn-small" onClick={() => quickPick("evening")}>
              6pm
            </button>
            <button className="btn-small" onClick={() => quickPick("morning")}>
              tomorrow 9am
            </button>
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="bg-surface border border-line rounded-md text-fg text-[12px] px-1.5 py-1 outline-none"
            />
          </div>

          {error && <div className="text-red text-[12px]">{error}</div>}

          <div className="flex justify-end">
            <button
              className="btn-create"
              style={{ padding: "5px 14px" }}
              onClick={handleSchedule}
              disabled={saving || !text.trim() || !at}
            >
              {saving ? "Scheduling…" : "Schedule"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
