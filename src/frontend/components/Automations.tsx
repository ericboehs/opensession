import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  fetchAutomations,
  createAutomationApi,
  updateAutomationApi,
  deleteAutomationApi,
  runAutomationApi,
  fetchModels,
  fetchAutomationTemplates,
  draftAutomationApi,
  fetchConnections,
  relativeTime,
  type ModelOption,
  type AutomationTemplate,
  type AutomationDraft,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";

interface AutomationRun {
  at: string;
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret?: string;
  eventKey?: string;
  mcpServers?: string[];
  slackWatch?: { channel: string };
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  nextRunAt: string | null;
  isRunning?: boolean;
  runs?: AutomationRun[];
}

interface Props {
  onOpenSession: (sessionId: string) => void;
}

const CUSTOM = "__custom__";

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily · 9:00 AM PT", cron: "0 16 * * *" },
  { label: "Daily · 9:00 AM CET", cron: "0 8 * * *" },
  { label: "Weekdays · 9:00 AM PT", cron: "0 16 * * 1-5" },
  { label: "Weekdays · 9:00 AM CET", cron: "0 8 * * 1-5" },
  { label: "Mondays · 9:00 AM CET", cron: "0 8 * * 1" },
  { label: "No schedule — webhook / manual only", cron: "" },
  { label: "Custom cron…", cron: CUSTOM },
];

const EVENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "plain:thread_created", label: "Plain — new support ticket created" },
  { key: "stripe:charge.dispute.created", label: "Stripe — dispute (chargeback) created" },
  { key: "github:pr_merged", label: "GitHub — PR merged" },
];

const WEBHOOK_BASE = "https://michael.tella.dev";

/** Claude subscription accounts, for the account-pin select + chips. */
interface ClaudeAccountOption {
  id: string;
  name: string;
  owner?: string;
}

function useClaudeAccounts(): ClaudeAccountOption[] {
  const [accounts, setAccounts] = useState<ClaudeAccountOption[]>([]);
  useEffect(() => {
    fetch("/backstage/api/claude-accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body && setAccounts(body.accounts))
      .catch(() => {});
  }, []);
  return accounts;
}

export function Automations({ onOpenSession }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const claudeAccounts = useClaudeAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
  }, []);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAutomations(await fetchAutomations());
      setLoading(false);
    } catch {}
  }, []);

  useEffect(() => {
    document.title = docTitle("Automations");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
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
            setShowModal(true);
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

      {showModal && (
        <CreateAutomationModal
          initial={editing}
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            load();
          }}
        />
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : automations.length === 0 && !showModal ? (
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
                <span
                  className="source-chip"
                  title={a.model ? "Model for this automation's runs" : "Default model (not overridden)"}
                >
                  {a.model || defaultModel || "default"}
                </span>
                {a.fallbackModel && a.fallbackModel !== "none" && (
                  <span
                    className="source-chip chip-fallback"
                    title="Fallback — used only when every account for the primary model has hit its usage limit"
                  >
                    ↯ {a.fallbackModel}
                  </span>
                )}
                {a.accountId && (
                  <span
                    className="source-chip"
                    title={
                      a.accountStrict === false
                        ? "Soft account pin — runs prefer this Claude subscription and fall back to the shared pool when it's out of usage"
                        : "Hard account pin — runs use only this Claude subscription; when it's out of usage they fall to the fallback model, never the shared pool"
                    }
                  >
                    {claudeAccounts.find((x) => x.id === a.accountId)?.name || "pinned account"}
                    {a.accountStrict === false ? " first" : " only"}
                  </span>
                )}
                {a.usageCredits && (
                  <span
                    className="source-chip"
                    title="May keep running on paid usage-credits once the account's subscription limits are spent (needs extra usage enabled on the account)"
                  >
                    +credits
                  </span>
                )}
                {(a.isRunning || a.lastRunStatus === "running") && (
                  <span className="working-pill">
                    <span className="working-dot" /> Running
                  </span>
                )}
                <div className="automation-actions">
                  {(a.runs?.length ?? 0) > 0 && (
                    <button
                      className="btn-small"
                      onClick={() => setExpandedRuns(expandedRuns === a.id ? null : a.id)}
                    >
                      {expandedRuns === a.id ? "Hide runs" : `Runs (${a.runs!.length})`}
                    </button>
                  )}
                  <button className="btn-small" onClick={() => handleRunNow(a)} disabled={a.isRunning}>
                    Run now
                  </button>
                  <button
                    className="btn-small"
                    onClick={() => {
                      setEditing(a);
                      setShowModal(true);
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

              {(a.runs?.length ?? 0) > 0 && <TriggerGraph runs={a.runs!} />}

              <div className="automation-meta">
                {a.slackWatch ? (
                  <span className="automation-cron automation-event" title="Runs on every top-level message in this Slack channel">
                    watching #{a.slackWatch.channel}
                  </span>
                ) : a.schedule ? (
                  <span className="automation-cron" title="UTC">{a.schedule}</span>
                ) : !a.eventKey ? (
                  <span className="automation-cron">webhook / manual</span>
                ) : null}
                {a.eventKey && (
                  <span className="automation-cron automation-event" title="Internal event trigger">
                    on {a.eventKey}
                  </span>
                )}
                {a.mcpServers && (
                  <span
                    className="automation-cron"
                    title="MCP servers this automation's runs can use (least privilege)"
                  >
                    mcp: {a.mcpServers.length === 0 ? "none" : a.mcpServers.join(", ")}
                  </span>
                )}
                {a.nextRunAt && a.enabled && (
                  <span>next {formatNext(a.nextRunAt)}</span>
                )}
                {a.lastRunAt && (
                  <span className="automation-lastrun">
                    last run {relativeTime(a.lastRunAt)}
                    {a.lastTrigger ? ` via ${a.lastTrigger}` : ""}
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

              {a.webhookSecret && <WebhookUrl id={a.id} secret={a.webhookSecret} />}

              {expandedRuns === a.id && (a.runs?.length ?? 0) > 0 && (
                <RunLedger runs={a.runs!} onOpenSession={onOpenSession} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Trigger history graph ────────────────────────────────────

const GRAPH_DAYS = 30;
const SLOT = 9; // 7px bar + 2px gap
const PLOT_H = 26;

/** Runs-per-day bar strip for the last 30 days. Status is state, so it uses
 *  the reserved status tokens (green/yellow/red); per-bar tooltips carry the
 *  counts in text and the expanded run ledger is the table view. */
function TriggerGraph({ runs }: { runs: AutomationRun[] }) {
  const buckets = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = Array.from({ length: GRAPH_DAYS }, (_, i) => {
      const date = new Date(today.getTime() - (GRAPH_DAYS - 1 - i) * 86_400_000);
      return { date, ok: 0, error: 0, running: 0 };
    });
    for (const r of runs) {
      const d = new Date(r.at);
      d.setHours(0, 0, 0, 0);
      const idx = Math.round((d.getTime() - out[0].date.getTime()) / 86_400_000);
      if (idx >= 0 && idx < out.length) out[idx][r.status]++;
    }
    return out;
  }, [runs]);

  const max = Math.max(1, ...buckets.map((b) => b.ok + b.error + b.running));
  const total = buckets.reduce((n, b) => n + b.ok + b.error + b.running, 0);
  if (total === 0) return null;

  return (
    <div className="flex items-end gap-2 mt-2">
      <svg
        width={GRAPH_DAYS * SLOT - 2}
        height={PLOT_H + 1}
        role="img"
        aria-label={`Trigger history: ${total} runs in the last ${GRAPH_DAYS} days`}
        className="shrink-0"
      >
        {/* baseline */}
        <rect x={0} y={PLOT_H} width={GRAPH_DAYS * SLOT - 2} height={1} fill="var(--border)" />
        {buckets.map((b, i) => {
          const count = b.ok + b.error + b.running;
          const label = b.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          if (count === 0) {
            return (
              <rect key={i} x={i * SLOT} y={PLOT_H - 2} width={SLOT - 2} height={2} rx={1} fill="var(--border)">
                <title>{`${label} — no runs`}</title>
              </rect>
            );
          }
          const h = Math.max(4, Math.round((count / max) * PLOT_H));
          const fill = b.error > 0 ? "var(--red)" : b.running > 0 ? "var(--yellow)" : "var(--green)";
          const parts = [
            b.ok ? `${b.ok} ok` : "",
            b.error ? `${b.error} failed` : "",
            b.running ? `${b.running} running` : "",
          ].filter(Boolean);
          return (
            <rect key={i} x={i * SLOT} y={PLOT_H - h} width={SLOT - 2} height={h} rx={1.5} fill={fill}>
              <title>{`${label} — ${count} run${count === 1 ? "" : "s"} (${parts.join(", ")})`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="text-faint text-[10px] leading-none pb-px">
        {total} run{total === 1 ? "" : "s"} · last {GRAPH_DAYS}d
      </span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Expandable run-history ledger for one automation (newest first). */
function RunLedger({
  runs,
  onOpenSession,
}: {
  runs: AutomationRun[];
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="mt-2.5 border-t border-line pt-2 flex flex-col gap-1">
      {runs.map((r) => (
        <div key={r.sessionId + r.at} className="flex items-baseline gap-2 text-[12px] text-dim min-w-0">
          {r.status === "running" ? (
            <span className="text-yellow shrink-0">●</span>
          ) : r.status === "ok" ? (
            <span className="text-green shrink-0">✓</span>
          ) : (
            <span className="text-red shrink-0" title={r.error}>✗</span>
          )}
          <span className="shrink-0" title={new Date(r.at).toLocaleString()}>
            {relativeTime(r.at)}
          </span>
          <span className="text-faint shrink-0">via {r.trigger}</span>
          {r.durationMs != null && (
            <span className="text-faint shrink-0">{formatDuration(r.durationMs)}</span>
          )}
          {r.error && (
            <span className="text-red truncate" title={r.error}>
              {r.error}
            </span>
          )}
          <a
            className="automation-session-link ml-auto shrink-0"
            href={`/backstage/session/${r.sessionId}`}
            onClick={(e) => {
              e.preventDefault();
              onOpenSession(r.sessionId);
            }}
          >
            view session
          </a>
        </div>
      ))}
    </div>
  );
}

function WebhookUrl({ id, secret }: { id: string; secret: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${WEBHOOK_BASE}/automations/${id}/${secret}`;

  return (
    <div className="automation-webhook">
      <span className="automation-webhook-label">webhook</span>
      <span className="automation-webhook-url" title={url}>
        POST {url.replace(secret, secret.slice(0, 6) + "…")}
      </span>
      <button
        className="btn-small"
        onClick={() => {
          navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied ✓" : "Copy URL"}
      </button>
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

// ── Create / edit modal ──────────────────────────────────────

type Step = "type" | "classic" | "watch";

const CATEGORY_LABELS: Record<AutomationTemplate["category"], string> = {
  sweep: "Sweep",
  digest: "Digest",
  investigator: "Investigator",
  triage: "Triage",
  hygiene: "Hygiene",
};

function CreateAutomationModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Automation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>(
    initial ? (initial.slackWatch ? "watch" : "classic") : "type",
  );
  const [prefill, setPrefill] = useState<AutomationDraft | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/45 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="automation-form w-full max-w-[680px] my-auto shadow-2xl">
        {step === "type" ? (
          <TypeChooser
            onPick={(draft, s) => {
              setPrefill(draft);
              setStep(s);
            }}
            onClose={onClose}
          />
        ) : (
          <AutomationForm
            kind={step}
            initial={initial}
            prefill={initial ? null : prefill}
            onBack={initial ? null : () => setStep("type")}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

/** Step 1: choose the automation type (plus templates and the AI drafter). */
function TypeChooser({
  onPick,
  onClose,
}: {
  onPick: (prefill: AutomationDraft | null, step: Exclude<Step, "type">) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAutomationTemplates().then(setTemplates).catch(() => {});
  }, []);

  async function handleDraft() {
    if (description.trim().length < 10 || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      onPick(await draftAutomationApi(description), "classic");
    } catch (e: any) {
      setError(e.message);
      setDrafting(false);
    }
  }

  return (
    <>
      <div>
        <div className="automation-form-title">Create automation</div>
        <div className="text-dim text-[13px] mt-0.5">
          Choose the type of automation you want to create.
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          className="text-left bg-surface border border-line rounded-panel px-4 py-3.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
          onClick={() => onPick(null, "classic")}
        >
          <div className="text-fg text-[14px] font-medium mb-1">Classical automation</div>
          <div className="text-dim text-[12.5px] leading-snug">
            Trigger Michael sessions based on schedules, internal events, and webhooks.
          </div>
        </button>
        <button
          className="text-left bg-surface border border-line rounded-panel px-4 py-3.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
          onClick={() => onPick(null, "watch")}
        >
          <div className="text-fg text-[14px] font-medium mb-1">Watch a channel</div>
          <div className="text-dim text-[12.5px] leading-snug">
            Michael triages every incoming message in a Slack channel, using the
            channel's memory as standing context.
          </div>
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-dim text-[12px]">Or describe it and Michael drafts the automation:</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDraft();
          }}
          rows={2}
          placeholder="“every weekday morning, check Sentry for new errors and rank them by impact”"
        />
        <div className="flex items-center gap-2">
          <button
            className="btn-create"
            style={{ padding: "6px 16px" }}
            onClick={handleDraft}
            disabled={drafting || description.trim().length < 10}
          >
            {drafting ? "Drafting…" : "Draft it"}
          </button>
          {error && <span className="text-red text-[12px]">{error}</span>}
        </div>
      </div>

      {templates.length > 0 && (
        <div>
          <div className="text-dim text-[12px] mb-1.5">Or start from a template — everything stays editable:</div>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {templates.map((t) => (
              <button
                key={t.id}
                className="text-left bg-surface border border-line rounded-panel px-3 py-2.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
                onClick={() => onPick(t, "classic")}
              >
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-fg text-[13px] font-medium">{t.name}</span>
                  <span className="text-faint text-[10px] tracking-[-0.01em] ml-auto shrink-0">
                    {CATEGORY_LABELS[t.category] || t.category}
                  </span>
                </div>
                <div className="text-dim text-[12px] leading-snug">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}

// ── MCP multi-select picker ──────────────────────────────────

/** Devin-style connector picker. `value` semantics match the server:
 *  undefined = all servers, [] = none, else the named allowlist. */
function McpPicker({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}) {
  const [servers, setServers] = useState<Array<{ name: string; status: string }>>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchConnections()
      .then((c) =>
        setServers(
          (c.mcpServers || []).map((s: any) => ({ name: s.name, status: s.status })),
        ),
      )
      .catch(() => {});
  }, []);

  const all = value === undefined;
  const selected = value || [];
  const shown = servers.filter((s) =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function toggle(name: string) {
    if (all) {
      // Leaving "all" mode by picking: start an explicit list with just this one
      onChange([name]);
      return;
    }
    onChange(
      selected.includes(name)
        ? selected.filter((n) => n !== name)
        : [...selected, name],
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-fg text-[13px] font-medium">MCPs</span>
        <span className="text-dim text-[12px]">
          Select which connectors this automation's runs can use
        </span>
        <a
          className="text-dim text-[12px] underline ml-auto shrink-0"
          href="/backstage/settings"
        >
          Manage MCPs
        </a>
      </div>
      <div className="bg-surface border border-line rounded-panel overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCPs…"
            className="flex-1 bg-transparent border-0 outline-none text-[13px] text-fg placeholder:text-faint"
            style={{ border: "none", padding: 0, background: "transparent" }}
          />
          <span className="text-faint text-[11px] shrink-0">
            {all ? "all connectors" : `${selected.length} selected`}
          </span>
        </div>
        <label
          className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-hover border-b border-line"
          style={{ flexDirection: "row", fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={all}
            onChange={() => onChange(all ? [] : undefined)}
            style={{ width: "auto" }}
          />
          <span className="text-fg">All connectors</span>
          <span className="text-faint text-[11px]">
            every configured server (pre-least-privilege default)
          </span>
        </label>
        <div className="max-h-[180px] overflow-y-auto">
          {shown.map((s) => (
            <label
              key={s.name}
              className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-hover"
              style={{ flexDirection: "row", fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={all || selected.includes(s.name)}
                onChange={() => toggle(s.name)}
                style={{ width: "auto" }}
              />
              <span className="text-fg">{s.name}</span>
              {s.status !== "connected" && s.status !== "ready" && (
                <span className="text-yellow text-[11px]">{s.status}</span>
              )}
            </label>
          ))}
          {shown.length === 0 && (
            <div className="px-3 py-2 text-faint text-[12px]">No connectors match.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Classic / watch form (step 2) ────────────────────────────

function AutomationForm({
  kind,
  initial,
  prefill,
  onBack,
  onClose,
  onSaved,
}: {
  kind: "classic" | "watch";
  initial: Automation | null;
  prefill?: AutomationDraft | null;
  onBack: (() => void) | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const startSchedule = initial ? initial.schedule : (prefill?.schedule ?? PRESETS[2].cron);
  const matchesPreset = PRESETS.some((p) => p.cron === startSchedule && p.cron !== CUSTOM);
  const initialPreset = matchesPreset ? startSchedule : CUSTOM;

  const [name, setName] = useState(initial?.name || prefill?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || prefill?.prompt || "");
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(!matchesPreset ? startSchedule : "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || prefill?.mode || "ask");
  const [eventKey, setEventKey] = useState(initial?.eventKey || prefill?.eventKey || "");
  const [watchChannel, setWatchChannel] = useState(initial?.slackWatch?.channel || "");
  const [mcpServers, setMcpServers] = useState<string[] | undefined>(
    initial ? initial.mcpServers : (prefill?.mcpServers ?? (kind === "watch" ? ["slack"] : undefined)),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(initial?.fallbackModel || "");
  const [accountId, setAccountId] = useState(initial?.accountId || "");
  const [accountStrict, setAccountStrict] = useState(initial?.accountStrict !== false);
  const [usageCredits, setUsageCredits] = useState(!!initial?.usageCredits);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const claudeAccounts = useClaudeAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWatch = kind === "watch";
  const schedule = isWatch ? "" : preset === CUSTOM ? customCron.trim() : preset;
  const scheduleValid = isWatch || preset !== CUSTOM || customCron.trim().length > 0;
  const watchValid = !isWatch || /^[CG][A-Z0-9]{6,}$/i.test(watchChannel.trim());

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const slackWatch = isWatch
        ? { channel: watchChannel.trim().toUpperCase() }
        : initial?.slackWatch
          ? { channel: "" } // editing a watch automation into a classic one clears it
          : undefined;
      if (initial) {
        await updateAutomationApi(initial.id, {
          name,
          prompt,
          schedule,
          mode,
          eventKey: isWatch ? "" : eventKey,
          model,
          fallbackModel,
          accountId,
          accountStrict,
          usageCredits,
          mcpServers: mcpServers ?? null,
          slackWatch,
        });
      } else {
        await createAutomationApi({
          name,
          prompt,
          schedule,
          mode,
          eventKey: (!isWatch && eventKey) || undefined,
          model: model || undefined,
          fallbackModel: fallbackModel || undefined,
          accountId: accountId || undefined,
          accountStrict: accountId && !accountStrict ? false : undefined,
          usageCredits: usageCredits || undefined,
          mcpServers,
          slackWatch,
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
    <>
      <div className="flex items-center gap-2">
        {onBack && (
          <button className="btn-small" onClick={onBack} title="Back to type chooser">
            ←
          </button>
        )}
        <div className="automation-form-title" style={{ marginBottom: 0 }}>
          {initial
            ? `Edit "${initial.name}"`
            : isWatch
              ? "Watch a channel"
              : "New automation"}
        </div>
      </div>

      <label>
        Automation name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isWatch ? "Support channel triage" : "Daily PR review sweep"}
        />
      </label>

      {isWatch ? (
        <label>
          Slack channel — what channel should Michael watch?
          <input
            value={watchChannel}
            onChange={(e) => setWatchChannel(e.target.value)}
            placeholder="C0123456789 (channel id)"
            className="mono-input"
          />
          <span className="text-faint text-[11.5px] leading-snug mt-1">
            Invite @michael to the channel first — the bot only receives messages
            for channels it's a member of. One run per top-level message; thread
            replies don't re-trigger. Channel id is in the channel's “About” tab.
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div>
            <span className="text-fg text-[13px] font-medium">Triggers</span>
            <span className="text-dim text-[12px] ml-2">
              Run the automation when any of these conditions are met
            </span>
          </div>
          <div className="bg-surface border border-line rounded-panel px-3 py-2.5 flex flex-col gap-2.5">
            <label style={{ marginBottom: 0 }}>
              Schedule
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {preset === CUSTOM && (
              <label style={{ marginBottom: 0 }}>
                Cron expression (UTC)
                <input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 16 * * 1-5"
                  className="mono-input"
                />
              </label>
            )}
            <label style={{ marginBottom: 0 }}>
              Internal event
              <select value={eventKey} onChange={(e) => setEventKey(e.target.value)}>
                <option value="">None</option>
                {EVENT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-faint text-[11.5px]">
              Every automation also gets a secret webhook URL you can POST to —
              shown on its card after creation.
            </div>
          </div>
        </div>
      )}

      <label>
        Instructions — what Michael does {isWatch ? "with each message" : "when triggers activate"}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder={
            isWatch
              ? "Tell Michael how to handle messages in this channel — e.g. “triage each report: reproduce, check Sentry, file a Linear issue, reply in the thread with what you found.”"
              : "What should Michael do on each run?"
          }
        />
      </label>

      <McpPicker value={mcpServers} onChange={setMcpServers} />

      <div>
        <button
          className="btn-small"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>
      </div>

      {showAdvanced && (
        <div className="automation-form-row">
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as "ask" | "code")}>
              <option value="ask">Ask — read-only on main</option>
              <option value="code">Code — fresh worktree per run</option>
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
            Fallback (when all accounts hit usage limits)
            <select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)}>
              <option value="">None — fail instead of falling back</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
                </option>
              ))}
            </select>
          </label>

          <label title="Pin runs to one subscription. Only applies to Claude models; Codex runs use the Codex pool.">
            Claude account
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Auto — shared pool rotation</option>
              {claudeAccounts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.owner ? ` — ${x.owner}'s` : ""}
                </option>
              ))}
            </select>
          </label>

          {accountId && (
            <label title="This account only: when it's out of usage, runs switch to the fallback model — never the shared pool — so this account's limits are the automation's cost ceiling. Prefer it: exhausted runs rotate into the shared pool instead.">
              When the pinned account is out of usage
              <select
                value={accountStrict ? "strict" : "pool"}
                onChange={(e) => setAccountStrict(e.target.value === "strict")}
              >
                <option value="strict">This account only — fall back by model (cost cap)</option>
                <option value="pool">Prefer it — fall back to the shared pool</option>
              </select>
            </label>
          )}

          <label title="Usage-credits are pay-as-you-go spend past the subscription's included limits. Only takes effect on accounts with extra usage enabled at claude.ai — and their monthly credit cap still bounds the spend.">
            Usage credits
            <select
              value={usageCredits ? "allow" : "never"}
              onChange={(e) => setUsageCredits(e.target.value === "allow")}
            >
              <option value="never">Never — stop / fall back at the limit</option>
              <option value="allow">Allowed — keep going on paid credits</option>
            </select>
          </label>
        </div>
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
          disabled={saving || !name.trim() || !prompt.trim() || !scheduleValid || !watchValid}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </button>
      </div>
    </>
  );
}
