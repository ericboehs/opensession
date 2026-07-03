import React, { useEffect, useRef, useState } from "react";
import {
  fetchScheduledPrompts,
  createScheduledPromptApi,
  deleteScheduledPromptApi,
  type ScheduledPrompt,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { IconChevronDown, IconClock } from "./icons";

/** "in 45m" / "in 3h" / "in 2d" for a future instant (short form). */
function inTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (d: Date) =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Composer "send later": schedules the *current composer draft* for this
 * session at a chosen time (Slack-style). Due prompts are delivered
 * server-side through the normal prompt path (steer / queue / fresh turn), so
 * they behave exactly like typing at that moment.
 *
 * Renders as the caret half of the send split button — a chevron that opens a
 * small menu of contextual quick picks ("Tomorrow at 9:00 AM", …) plus a
 * "Custom time" entry that opens a date/time dialog. The caret is disabled in
 * lockstep with the send button (empty draft → nothing to schedule), so the
 * whole split button greys out together.
 */
export function SchedulePromptButton({
  sessionId,
  text,
  disabled,
  onScheduled,
  variant = "caret",
}: {
  sessionId: string;
  /** Current composer draft — the message that gets scheduled. */
  text: string;
  disabled?: boolean;
  /** Called after a successful schedule so the composer can clear its draft. */
  onScheduled?: () => void;
  variant?: "caret" | "menu-item";
}) {
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [pending, setPending] = useState<ScheduledPrompt[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const hasText = text.trim().length > 0;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

  // Close menu on outside click; Escape closes menu or dialog.
  useEffect(() => {
    if (!open && !customOpen) return;
    const onDown = (e: MouseEvent) => {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCustomOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, customOpen]);

  // Contextual quick picks (Slack-style): later today, tomorrow, next Monday —
  // all at sensible hours, de-duped and always in the future.
  function quickOptions(): { label: string; at: Date }[] {
    const now = new Date();
    const out: { label: string; at: Date }[] = [];
    const seen = new Set<string>();
    const add = (label: string, at: Date) => {
      const k = at.toISOString();
      if (at.getTime() > now.getTime() + 30_000 && !seen.has(k)) {
        seen.add(k);
        out.push({ label, at });
      }
    };
    const today6pm = new Date(now);
    today6pm.setHours(18, 0, 0, 0);
    add(`Today at ${fmtTime(today6pm)}`, today6pm);
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    add(`Tomorrow at ${fmtTime(tomorrow)}`, tomorrow);
    const monday = new Date(now);
    monday.setDate(now.getDate() + (((8 - monday.getDay()) % 7) || 7));
    monday.setHours(9, 0, 0, 0);
    add(
      `${monday.toLocaleDateString([], { weekday: "long" })} at ${fmtTime(monday)}`,
      monday,
    );
    return out.slice(0, 3);
  }

  async function schedule(at: Date) {
    const prompt = text.trim();
    if (!prompt || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createScheduledPromptApi(sessionId, {
        prompt,
        at: at.toISOString(),
        user: getCurrentUser(),
      });
      setOpen(false);
      setCustomOpen(false);
      onScheduled?.();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  function openCustom() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setDate(toDateInput(d));
    setTime("09:00");
    setError(null);
    setOpen(false);
    setCustomOpen(true);
  }

  function scheduleCustom() {
    if (!date || !time) return;
    const at = new Date(`${date}T${time}`);
    if (isNaN(at.getTime())) {
      setError("Pick a valid date and time.");
      return;
    }
    if (at.getTime() <= Date.now()) {
      setError("Pick a time in the future.");
      return;
    }
    void schedule(at);
  }

  return (
    <div
      ref={rootRef}
      className={`composer-schedule-wrap ${variant === "menu-item" ? "composer-schedule-wrap-menu" : ""}`}
    >
      <button
        type="button"
        className={
          variant === "menu-item"
            ? "composer-menu-item composer-schedule-item"
            : `composer-send-caret ${open ? "is-open" : ""}`
        }
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Schedule for later"
        aria-label="Schedule for later"
      >
        {variant === "menu-item" ? (
          <>
            <span className="composer-menu-icon">
              <IconClock size={22} />
            </span>
            <span>Schedule message</span>
          </>
        ) : (
          <IconChevronDown size={20} />
        )}
        {pending.length > 0 && (
          <span className="composer-schedule-badge">{pending.length}</span>
        )}
      </button>

      {open && (
        <div className="composer-menu composer-schedule-menu" role="menu">
          {pending.length > 0 && (
            <div className="composer-schedule-pending">
              {pending.map((p) => (
                <div key={p.id} className="composer-schedule-perow">
                  <span
                    className="composer-schedule-pin"
                    title={new Date(p.at).toLocaleString()}
                  >
                    {inTime(p.at)}
                  </span>
                  <span className="composer-schedule-ptext" title={p.prompt}>
                    {p.prompt}
                  </span>
                  <button
                    type="button"
                    className="composer-schedule-pcancel"
                    title="Cancel this scheduled message"
                    onClick={async () => {
                      try {
                        await deleteScheduledPromptApi(p.id);
                        load();
                      } catch {}
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-schedule-head">Schedule message</div>
          {quickOptions().map((o) => (
            <button
              key={o.at.toISOString()}
              type="button"
              role="menuitem"
              className="composer-menu-item"
              onClick={() => schedule(o.at)}
              disabled={saving || !hasText}
            >
              {o.label}
            </button>
          ))}
          <div className="composer-schedule-sep" />
          <button
            type="button"
            role="menuitem"
            className="composer-menu-item"
            onClick={openCustom}
            disabled={!hasText}
          >
            Custom time
          </button>
          {error && !customOpen && (
            <div className="composer-schedule-err">{error}</div>
          )}
        </div>
      )}

      {customOpen && (
        <div
          className="composer-schedule-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCustomOpen(false);
          }}
        >
          <div className="composer-schedule-modal">
            <div className="composer-schedule-modal-head">
              <div>
                <div className="composer-schedule-modal-title">Schedule message</div>
                <div className="composer-schedule-modal-tz">Time zone: {tz}</div>
              </div>
              <button
                type="button"
                className="composer-schedule-modal-close"
                onClick={() => setCustomOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="composer-schedule-modal-fields">
              <input
                type="date"
                value={date}
                min={toDateInput(new Date())}
                onChange={(e) => setDate(e.target.value)}
                className="composer-schedule-input"
              />
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="composer-schedule-input composer-schedule-input-time"
              />
            </div>
            {error && <div className="composer-schedule-err">{error}</div>}
            <div className="composer-schedule-modal-actions">
              <button
                type="button"
                className="composer-schedule-cancel"
                onClick={() => setCustomOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="composer-schedule-submit"
                onClick={scheduleCustom}
                disabled={saving || !date || !time}
              >
                {saving ? "Scheduling…" : "Schedule Message"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
