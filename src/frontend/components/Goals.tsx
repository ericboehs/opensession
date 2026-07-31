import { BASE_PATH } from "../lib/base";
import React, { useEffect, useMemo, useState, useCallback } from "react";
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
  fetchRepos,
  relativeTime,
  type ModelOption,
  type RepoInfo,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { InlineAlert } from "../ui/state";

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
  /** Selected goal id (or name) — from the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

const STATUS_COLOR: Record<GoalStatus, string> = {
  active: "#1f9d55",
  paused: "#b7791f",
  done: "#3182ce",
  failed: "#e03131",
};

export function Goals({ onOpenSession, selectedId, onSelect }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    document.title = docTitle("Goals");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // The routed selection — matched by id, or by name for deep-links.
  const sel = useMemo(
    () =>
      selectedId
        ? goals.find((g) => g.id === selectedId || g.name === selectedId) || null
        : null,
    [goals, selectedId],
  );

  // Leaving the selection also leaves edit mode.
  useEffect(() => setEditMode(false), [sel?.id]);

  // Escape backs out one layer: inline edit → read view → closed.
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!sel, editMode, onSelect]);

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
    if (sel?.id === g.id) onSelect("");
    await act(() => deleteGoalApi(g.id), 100);
  }

  return (
    <div className={`automations-page ${sel ? "automations-page-has-detail" : ""}`}>
    <div className="automations-page-main">
    <div className="automations-page-inner">
      <PageHeader
        className={`max-[560px]:mb-5 max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5 ${
          sel ? "mb-3.5 items-center" : ""
        }`}
      >
        <div>
          <PageTitle className={sel ? "text-item-title" : undefined}>Goals</PageTitle>
          <PageDescription className={sel ? "hidden" : undefined}>
            Long-running, self-pacing missions — one managed session that remembers its own
            progress, paces itself, and stops when done.
          </PageDescription>
        </div>
        <Button
					variant="primary"
					size="lg"
					className="px-[18px] text-control-label font-medium"
					onClick={() => setShowForm(true)}
				>
					+ New goal
				</Button>
      </PageHeader>

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}

      {showForm && (
        <GoalForm
          initial={null}
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
        <div className="automations-table">
          {goals.map((g) => {
            const running = g.isRunning || g.lastRunStatus === "running";
            return (
              <button
                key={g.id}
                className={`automations-row ${sel?.id === g.id ? "active" : ""} ${g.status === "active" ? "" : "automations-row-off"}`}
                onClick={() => onSelect(g.id)}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: STATUS_COLOR[g.status] }}
                  title={g.pauseReason || g.doneReason || g.status}
                />
                <span className="automations-row-main">
                  <span className="automations-row-name">{g.name}</span>
                  <span className="automations-row-trigger">
                    {g.status}
                    {g.phase ? ` · ${g.phase}` : ""}
                    {` · wake #${g.wakeCount}${g.maxWakes ? ` / ${g.maxWakes}` : ""}`}
                  </span>
                </span>
                {running ? (
                  <span className="working-pill">
                    <span className="working-dot" /> Running
                  </span>
                ) : g.lastRunStatus === "ok" ? (
                  <span
                    className="auto-status-ok"
                    title={`Last wake ok${g.lastRunAt ? ` — ${relativeTime(g.lastRunAt)}` : ""}`}
                  >
                    ✓
                  </span>
                ) : g.lastRunStatus === "error" ? (
                  <span className="auto-status-err" title={g.lastRunError || "Last wake failed"}>
                    ✗
                  </span>
                ) : null}
                <span className="automations-row-next">
                  {g.status === "active" && g.nextWakeAt
                    ? `next ${formatNext(g.nextWakeAt)}`
                    : g.status}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
    </div>

      {sel && (
        <aside className="automations-drawer">
          <div className="automations-drawer-head">
            <button
              className="automations-drawer-back"
              onClick={() => onSelect("")}
              title="Back to goals"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Goals
            </button>
            <span className="automations-drawer-title">
              {editMode ? `Edit — ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div className="automations-drawer-actions">
                {sel.status === "active" && (
                  <Button
                    size="sm"
                    className="border-line-strong bg-transparent"
                    onClick={() => act(() => runGoalApi(sel.id))}
                    disabled={sel.isRunning}
                  >
                    Wake now
                  </Button>
                )}
                {sel.status === "active" ? (
                  <Button size="sm" className="border-line-strong bg-transparent" onClick={() => act(() => pauseGoalApi(sel.id))}>
                    Pause
                  </Button>
                ) : (
                  <Button size="sm" className="border-line-strong bg-transparent" onClick={() => act(() => resumeGoalApi(sel.id))}>
                    Resume
                  </Button>
                )}
                <Button size="sm" className="border-line-strong bg-transparent" onClick={() => setEditMode(true)}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" onClick={() => handleDelete(sel)}>
                  Delete
                </Button>
              </div>
            )}
            <button
              className="automations-drawer-close"
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div className="automations-drawer-body">
            {editMode ? (
              <GoalForm
                key={sel.id}
                inline
                initial={sel}
                onClose={() => setEditMode(false)}
                onSaved={() => {
                  setEditMode(false);
                  load();
                }}
              />
            ) : (
              <>
                <div className="flex items-center gap-2.5">
                  <span
                    className="source-chip"
                    style={{ background: STATUS_COLOR[sel.status], color: "#fff" }}
                  >
                    {sel.status}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <span className="working-pill">
                      <span className="working-dot" /> Running
                    </span>
                  )}
                  {sel.status === "active" && sel.nextWakeAt && (
                    <span className="text-faint text-label ml-auto shrink-0" title={sel.nextWakeAt}>
                      next wake {formatNext(sel.nextWakeAt)}
                    </span>
                  )}
                </div>
                {sel.status === "paused" && sel.pauseReason && (
                  <div className="text-dim text-supporting leading-snug">
                    Paused — {sel.pauseReason}
                  </div>
                )}
                {(sel.status === "done" || sel.status === "failed") && sel.doneReason && (
                  <div className="text-dim text-supporting leading-snug">
                    {sel.status === "done" ? "Done" : "Failed"} — {sel.doneReason}
                  </div>
                )}

                <div>
                  <div className="automations-drawer-section-label mb-1.5">Mission</div>
                  <div className="bg-surface border border-line rounded-panel px-3.5 py-3 text-[13px] leading-relaxed text-dim whitespace-pre-wrap">
                    {sel.mission}
                  </div>
                </div>

                <div>
                  <div className="automations-drawer-section-label mb-1.5">Configuration</div>
                  <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-[13px]">
                    <DetailKey>Mode</DetailKey>
                    <span className="text-dim">
                      {sel.mode === "ask"
                        ? "Ask — read-only research/measure"
                        : `Code — persistent worktree${sel.repo ? ` in ${sel.repo}` : ""}, can open PRs`}
                    </span>

                    {sel.phase && (
                      <>
                        <DetailKey>Phase</DetailKey>
                        <span className="text-dim min-w-0">{sel.phase}</span>
                      </>
                    )}

                    <DetailKey>Model</DetailKey>
                    <span className="text-dim">
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          className="text-faint"
                          title="Fallback — used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}· falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    <DetailKey>Cadence</DetailKey>
                    <span className="text-dim">
                      at least {sel.minWakeMinutes}m between wakes
                      {sel.maxWakes ? ` · capped at ${sel.maxWakes} wakes` : ""}
                    </span>

                    <DetailKey>MCPs</DetailKey>
                    <span className="text-dim min-w-0">
                      {sel.mcpServers?.length ? sel.mcpServers.join(", ") : "all connectors"}
                    </span>

                    {sel.bksSessionId && (
                      <>
                        <DetailKey>Session</DetailKey>
                        <span className="min-w-0">
                          <a
                            className="automation-session-link"
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSession(sel.bksSessionId!);
                            }}
                            href={`${BASE_PATH}/session/${sel.bksSessionId}`}
                          >
                            open the goal's session
                          </a>
                        </span>
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span className="text-dim">by {sel.createdBy}</span>
                  </div>
                </div>

                <div>
                  <div className="automations-drawer-section-label mb-1.5">Activity</div>
                  <div className="text-dim text-supporting mb-2">
                    wake #{sel.wakeCount}
                    {sel.maxWakes ? ` of ${sel.maxWakes}` : ""}
                    {sel.lastRunAt && (
                      <>
                        {" · last wake "}
                        {relativeTime(sel.lastRunAt)}
                        {sel.lastRunStatus === "ok" && <span className="auto-status-ok"> ✓</span>}
                        {sel.lastRunStatus === "error" && (
                          <span className="auto-status-err" title={sel.lastRunError}> ✗</span>
                        )}
                      </>
                    )}
                  </div>
                  <GoalLedger id={sel.id} />
                </div>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">{children}</span>
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
        margin: 0,
        padding: "10px 12px",
        background: "var(--bg-raised)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontFamily: "var(--mono)",
        fontSize: 13,
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
  inline,
  onClose,
  onSaved,
}: {
  initial: Goal | null;
  /** Hosted in the detail drawer: drop the card chrome + redundant title. */
  inline?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [mission, setMission] = useState(initial?.mission || "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || "ask");
  const [repo, setRepo] = useState(initial?.repo || "");
  const [repos, setRepos] = useState<RepoInfo[]>([]);
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
    Promise.all([fetchModels(), fetchRepos()])
      .then(([m, repoItems]) => {
        setModels(m.models);
        setDefaultModel(m.default);
        setRepos(repoItems);
        setRepo((current) =>
          current ||
          repoItems.find((item) => item.default)?.id ||
          repoItems[0]?.id ||
          "",
        );
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
    <div className={`automation-form ${inline ? "automation-form-inline" : ""}`}>
      {!inline && (
        <div className="automation-form-title">
          {initial ? `Edit "${initial.name}"` : "New goal"}
        </div>
      )}

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
          placeholder="The full mission brief: objective, strategy, operating loop, hard rules. It's restated to the agent every wake."
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
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label || item.id}
              </option>
            ))}
          </select>
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
            <option value="">None — fail instead</option>
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

      {error && <InlineAlert>{error}</InlineAlert>}

      <div className="automation-form-actions">
        <Button size="md" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="px-[22px] py-2"
          onClick={handleSave}
          disabled={saving || !name.trim() || !mission.trim()}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create goal"}
        </Button>
      </div>
    </div>
  );
}
