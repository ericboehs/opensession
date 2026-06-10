import React, { useEffect, useState, useCallback } from "react";
import {
  fetchAutomations,
  createAutomationApi,
  updateAutomationApi,
  deleteAutomationApi,
  runAutomationApi,
  relativeTime,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";

interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  nextRunAt: string | null;
  isRunning?: boolean;
}

interface Props {
  onOpenSession: (sessionId: string) => void;
}

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily · 9:00 AM PT", cron: "0 16 * * *" },
  { label: "Daily · 9:00 AM CET", cron: "0 8 * * *" },
  { label: "Weekdays · 9:00 AM PT", cron: "0 16 * * 1-5" },
  { label: "Weekdays · 9:00 AM CET", cron: "0 8 * * 1-5" },
  { label: "Mondays · 9:00 AM CET", cron: "0 8 * * 1" },
  { label: "Custom cron…", cron: "" },
];

export function Automations({ onOpenSession }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAutomations(await fetchAutomations());
      setLoading(false);
    } catch {}
  }, []);

  useEffect(() => {
    document.title = "Automations — Michael";
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = "Michael — Tella";
    };
  }, [load]);

  async function handleToggle(a: Automation) {
    try {
      await updateAutomationApi(a.id, { enabled: !a.enabled });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDelete(a: Automation) {
    if (!confirm(`Delete automation "${a.name}"?`)) return;
    try {
      await deleteAutomationApi(a.id);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleRunNow(a: Automation) {
    try {
      await runAutomationApi(a.id);
      setTimeout(load, 800);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="automations">
      <div className="page-header">
        <div>
          <h2 className="page-title">Automations</h2>
          <div className="page-sub">
            Scheduled Michael sessions — cron runs in UTC (server time).
          </div>
        </div>
        <button
          className="btn-new-session"
          style={{ marginTop: 0 }}
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          + New automation
        </button>
      </div>

      {error && (
        <div className="form-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <AutomationForm
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : automations.length === 0 && !showForm ? (
        <div className="automations-empty">
          <p>No automations yet.</p>
          <p className="automations-empty-sub">
            Schedule recurring work: daily PR-review sweeps, dependency checks, weekly
            changelog drafts, flaky-test hunts…
          </p>
        </div>
      ) : (
        <div className="automation-list">
          {automations.map((a) => (
            <div key={a.id} className={`automation-card ${a.enabled ? "" : "automation-disabled"}`}>
              <div className="automation-top">
                <button
                  className={`auto-toggle ${a.enabled ? "auto-toggle-on" : ""}`}
                  onClick={() => handleToggle(a)}
                  title={a.enabled ? "Disable" : "Enable"}
                >
                  <span className="auto-toggle-knob" />
                </button>
                <span className="automation-name">{a.name}</span>
                <span className={`source-chip ${a.mode === "ask" ? "source-ask" : "source-backstage"}`}>
                  {a.mode}
                </span>
                {(a.isRunning || a.lastRunStatus === "running") && (
                  <span className="working-pill">
                    <span className="working-dot" /> Running
                  </span>
                )}
                <div className="automation-actions">
                  <button className="btn-small" onClick={() => handleRunNow(a)} disabled={a.isRunning}>
                    Run now
                  </button>
                  <button
                    className="btn-small"
                    onClick={() => {
                      setEditing(a);
                      setShowForm(true);
                    }}
                  >
                    Edit
                  </button>
                  <button className="btn-small btn-small-danger" onClick={() => handleDelete(a)}>
                    Delete
                  </button>
                </div>
              </div>

              <div className="automation-prompt">{a.prompt}</div>

              <div className="automation-meta">
                <span className="automation-cron" title="UTC">{a.schedule}</span>
                {a.nextRunAt && a.enabled && (
                  <span>next {formatNext(a.nextRunAt)}</span>
                )}
                {a.lastRunAt && (
                  <span className="automation-lastrun">
                    last run {relativeTime(a.lastRunAt)}
                    {a.lastRunStatus === "ok" && <span className="auto-status-ok"> ✓</span>}
                    {a.lastRunStatus === "error" && (
                      <span className="auto-status-err" title={a.lastRunError}> ✗</span>
                    )}
                    {a.lastRunSessionId && (
                      <>
                        {" · "}
                        <a
                          className="automation-session-link"
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenSession(a.lastRunSessionId!);
                          }}
                          href={`/backstage/session/${a.lastRunSessionId}`}
                        >
                          view session
                        </a>
                      </>
                    )}
                  </span>
                )}
                <span className="automation-by">by {a.createdBy}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

function AutomationForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Automation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialPreset =
    initial ? (PRESETS.find((p) => p.cron === initial.schedule) ? initial.schedule : "") : PRESETS[2].cron;

  const [name, setName] = useState(initial?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || "");
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(
    initial && !PRESETS.find((p) => p.cron === initial.schedule) ? initial.schedule : ""
  );
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || "ask");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedule = preset === "" ? customCron.trim() : preset;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (initial) {
        await updateAutomationApi(initial.id, { name, prompt, schedule, mode });
      } else {
        await createAutomationApi({
          name,
          prompt,
          schedule,
          mode,
          createdBy: getCurrentUser(),
        });
      }
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="automation-form">
      <div className="automation-form-title">
        {initial ? `Edit "${initial.name}"` : "New automation"}
      </div>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily PR review sweep" />
      </label>

      <label>
        Prompt
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="What should Michael do on each run?"
        />
      </label>

      <div className="automation-form-row">
        <label>
          Schedule
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.label} value={p.cron}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as "ask" | "code")}>
            <option value="ask">Ask — read-only on main</option>
            <option value="code">Code — fresh worktree per run</option>
          </select>
        </label>
      </div>

      {preset === "" && (
        <label>
          Cron expression (UTC)
          <input
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 16 * * 1-5"
            className="mono-input"
          />
        </label>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleSave}
          disabled={saving || !name.trim() || !prompt.trim() || !schedule}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </button>
      </div>
    </div>
  );
}
