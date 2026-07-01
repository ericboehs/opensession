import React, { useEffect, useState, useCallback } from "react";
import {
  fetchGoals,
  fetchGoal,
  createGoalApi,
  updateGoalApi,
  deleteGoalApi,
  runGoalApi,
  resumeGoalApi,
  pauseGoalApi,
  fetchModels,
  relativeTime,
  type ModelOption,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";

type GoalStatus = "active" | "paused" | "done" | "failed";

interface Goal {
  id: string;
  name: string;
  mission: string;
  status: GoalStatus;
  mode: "ask" | "code";
  repo?: string;
  bksSessionId?: string;
  nextWakeAt: string;
  minWakeMinutes: number;
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  phase?: string;
  pauseReason?: string;
  doneReason?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  createdBy: string;
  isRunning?: boolean;
}

interface Props {
  onOpenSession: (sessionId: string) => void;
}

const STATUS_COLOR: Record<GoalStatus, string> = {
  active: "#1f9d55",
  paused: "#b7791f",
  done: "#3182ce",
  failed: "#e03131",
};

export function Goals({ onOpenSession }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      setGoals(await fetchGoals());
      setLoading(false);
    } catch {}
  }, []);

  useEffect(() => {
    document.title = "Goals — Michael";
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = "Michael — Tella";
    };
  }, [load]);

  async function act(fn: () => Promise<unknown>, refreshDelay = 400) {
    try {
      await fn();
      setTimeout(load, refreshDelay);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDelete(g: Goal) {
    if (!confirm(`Delete goal "${g.name}" and its ledger? The session it created is left as-is.`))
      return;
    await act(() => deleteGoalApi(g.id), 100);
  }

  return (
    <div className="automations">
      <div className="page-header">
        <div>
          <h2 className="page-title">Goals</h2>
          <div className="page-sub">
            Long-running, self-pacing missions — one managed session that remembers its own
            progress, paces itself, and stops when done.
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
          + New goal
        </button>
      </div>

      {error && (
        <div className="form-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <GoalForm
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
      ) : goals.length === 0 && !showForm ? (
        <div className="automations-empty">
          <p>No goals yet.</p>
          <p className="automations-empty-sub">
            A goal pursues one mission over days/weeks — it wakes itself, reads its ledger,
            ships work via PRs, measures, and iterates until the objective is met.
          </p>
        </div>
      ) : (
        <div className="automation-list">
          {goals.map((g) => (
            <div
              key={g.id}
              className={`automation-card ${g.status !== "active" ? "automation-disabled" : ""}`}
            >
              <div className="automation-top">
                <span
                  className="source-chip"
                  style={{ background: STATUS_COLOR[g.status], color: "#fff" }}
                  title={g.pauseReason || g.doneReason || g.status}
                >
                  {g.status}
                </span>
                <span className="automation-name">{g.name}</span>
                <span className={`source-chip ${g.mode === "ask" ? "source-ask" : "source-backstage"}`}>
                  {g.mode}
                </span>
                <span className="source-chip" title="Model for this goal's runs">
                  {g.model || defaultModel || "default"}
                </span>
                {g.phase && (
                  <span className="source-chip" title="Current phase">
                    {g.phase}
                  </span>
                )}
                {(g.isRunning || g.lastRunStatus === "running") && (
                  <span className="working-pill">
                    <span className="working-dot" /> Running
                  </span>
                )}
                <div className="automation-actions">
                  {g.status === "active" && (
                    <button
                      className="btn-small"
                      onClick={() => act(() => runGoalApi(g.id))}
                      disabled={g.isRunning}
                    >
                      Wake now
                    </button>
                  )}
                  {g.status === "active" && (
                    <button className="btn-small" onClick={() => act(() => pauseGoalApi(g.id))}>
                      Pause
                    </button>
                  )}
                  {g.status !== "active" && (
                    <button className="btn-small" onClick={() => act(() => resumeGoalApi(g.id))}>
                      Resume
                    </button>
                  )}
                  <button
                    className="btn-small"
                    onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                  >
                    {expanded === g.id ? "Hide" : "Ledger"}
                  </button>
                  <button
                    className="btn-small"
                    onClick={() => {
                      setEditing(g);
                      setShowForm(true);
                    }}
                  >
                    Edit
                  </button>
                  <button className="btn-small btn-small-danger" onClick={() => handleDelete(g)}>
                    Delete
                  </button>
                </div>
              </div>

              <div className="automation-prompt">{g.mission}</div>

              <div className="automation-meta">
                <span>wake #{g.wakeCount}{g.maxWakes ? ` / ${g.maxWakes}` : ""}</span>
                {g.status === "active" && g.nextWakeAt && (
                  <span title={g.nextWakeAt}>next {formatNext(g.nextWakeAt)}</span>
                )}
                {g.status === "paused" && g.pauseReason && (
                  <span className="automation-event" title={g.pauseReason}>
                    paused — {g.pauseReason.slice(0, 60)}
                  </span>
                )}
                {(g.status === "done" || g.status === "failed") && g.doneReason && (
                  <span title={g.doneReason}>
                    {g.status} — {g.doneReason.slice(0, 60)}
                  </span>
                )}
                {g.lastRunAt && (
                  <span className="automation-lastrun">
                    last wake {relativeTime(g.lastRunAt)}
                    {g.lastRunStatus === "ok" && <span className="auto-status-ok"> ✓</span>}
                    {g.lastRunStatus === "error" && (
                      <span className="auto-status-err" title={g.lastRunError}> ✗</span>
                    )}
                  </span>
                )}
                {g.bksSessionId && (
                  <a
                    className="automation-session-link"
                    onClick={(e) => {
                      e.preventDefault();
                      onOpenSession(g.bksSessionId!);
                    }}
                    href={`/backstage/session/${g.bksSessionId}`}
                  >
                    open session
                  </a>
                )}
                <span className="automation-by">by {g.createdBy}</span>
              </div>

              {expanded === g.id && <GoalLedger id={g.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lazily fetch + show a goal's full mission + ledger. */
function GoalLedger({ id }: { id: string }) {
  const [ledger, setLedger] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchGoal(id)
      .then((g) => {
        if (alive) setLedger(g.ledger || "(ledger is empty)");
      })
      .catch(() => alive && setLedger("(failed to load ledger)"));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 360,
        overflow: "auto",
        margin: "8px 0 2px",
        padding: "10px 12px",
        background: "var(--bg-inset, #f6f7f9)",
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {ledger === null ? "Loading ledger…" : ledger}
    </pre>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

function GoalForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Goal | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [mission, setMission] = useState(initial?.mission || "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || "ask");
  const [repo, setRepo] = useState(initial?.repo || "tella-fusion");
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(initial?.fallbackModel || "");
  const [mcpServers, setMcpServers] = useState((initial?.mcpServers || []).join(", "));
  const [minWakeMinutes, setMinWakeMinutes] = useState(String(initial?.minWakeMinutes ?? 30));
  const [maxWakes, setMaxWakes] = useState(initial?.maxWakes ? String(initial.maxWakes) : "");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const servers = mcpServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      name,
      mission,
      mode,
      repo: repo.trim() || undefined,
      model: model || undefined,
      fallbackModel: fallbackModel || undefined,
      mcpServers: servers.length ? servers : undefined,
      minWakeMinutes: Number(minWakeMinutes) || undefined,
      maxWakes: maxWakes.trim() ? Number(maxWakes) : undefined,
    };
    try {
      if (initial) {
        await updateGoalApi(initial.id, payload);
      } else {
        await createGoalApi({ ...payload, createdBy: getCurrentUser() });
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
        {initial ? `Edit "${initial.name}"` : "New goal"}
      </div>

      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rank #1: screen recording software"
        />
      </label>

      <label>
        Mission
        <textarea
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={12}
          placeholder="The full mission brief — objective, strategy, operating loop, hard rules. It's restated to the agent every wake."
        />
      </label>

      <div className="automation-form-row">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as "ask" | "code")}>
            <option value="ask">Ask — read-only research/measure</option>
            <option value="code">Code — persistent worktree, can open PRs</option>
          </select>
        </label>

        <label>
          Repo (code mode)
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="tella-fusion"
            className="mono-input"
          />
        </label>

        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default{defaultModel ? ` — ${defaultModel}` : ""}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
              </option>
            ))}
          </select>
        </label>

        <label>
          Fallback (all accounts hit limits)
          <select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)}>
            <option value="">Default — gpt-5.5</option>
            <option value="none">None — fail instead</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="automation-form-row">
        <label>
          MCP servers (comma-separated; blank = all)
          <input
            value={mcpServers}
            onChange={(e) => setMcpServers(e.target.value)}
            placeholder="ahrefs, slack"
            className="mono-input"
          />
        </label>

        <label>
          Min minutes between wakes
          <input
            type="number"
            value={minWakeMinutes}
            onChange={(e) => setMinWakeMinutes(e.target.value)}
            placeholder="30"
          />
        </label>

        <label>
          Max wakes (safety cap; blank = none)
          <input
            type="number"
            value={maxWakes}
            onChange={(e) => setMaxWakes(e.target.value)}
            placeholder="—"
          />
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleSave}
          disabled={saving || !name.trim() || !mission.trim()}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create goal"}
        </button>
      </div>
    </div>
  );
}
