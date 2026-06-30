import React, { useCallback, useEffect, useState } from "react";
import {
  fetchActions,
  createActionApi,
  deleteActionApi,
  runActionApi,
  introspectActionApi,
  relativeTime,
  type Action,
  type ActionInput,
  type ActionInputType,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";

interface Props {
  onOpenSession: (sessionId: string) => void;
}

/**
 * Actions: run a registered repo script behind a form. Each run spins up a real
 * (fast-model) session that executes the script — open it to watch the output,
 * fork it into a full session to dig in.
 */
export function Actions({ onOpenSession }: Props) {
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [running, setRunning] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setActions(await fetchActions());
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Actions — Michael";
    load();
    return () => {
      document.title = "Michael — Tella";
    };
  }, [load]);

  async function handleDelete(a: Action) {
    if (!confirm(`Delete action "${a.name}"?`)) return;
    try {
      await deleteActionApi(a.id);
      load();
    } catch (e: any) {
      setError(e.message || String(e));
    }
  }

  return (
    <div className="automations">
      <div className="page-header">
        <div>
          <h2 className="page-title">Actions</h2>
          <div className="page-sub">
            Run a registered repo script behind a form. Each run opens as a session you can fork.
          </div>
        </div>
        <button className="btn-new-session" onClick={() => setShowForm(true)}>
          + New action
        </button>
      </div>

      {error && (
        <div className="form-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <ActionForm
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {running && (
        <RunDialog
          action={running}
          onClose={() => setRunning(null)}
          onRan={(sessionId) => {
            setRunning(null);
            load();
            onOpenSession(sessionId);
          }}
        />
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : actions.length === 0 ? (
        <div className="automations-empty">
          <p>No actions yet.</p>
          <p className="automations-empty-sub">
            Register a script from a repo (e.g. packages/scripts/make_michiel_editor.sh).
          </p>
        </div>
      ) : (
        <div className="automation-list">
          {actions.map((a) => (
            <div key={a.id} className="automation-card">
              <div className="automation-top">
                <span className="automation-name">{a.name}</span>
                <span className="source-chip source-backstage">
                  {a.kind === "mcp" ? "mcp" : a.repo}
                </span>
                {a.confirm && <span className="source-chip">confirm</span>}
                <div className="automation-actions">
                  <button className="btn-small" onClick={() => setRunning(a)}>
                    Run
                  </button>
                  <button className="btn-small btn-small-danger" onClick={() => handleDelete(a)}>
                    Delete
                  </button>
                </div>
              </div>
              {a.description && <div className="automation-prompt">{a.description}</div>}
              <div className="automation-meta">
                <span
                  className="automation-cron"
                  title={a.kind === "mcp" ? "MCP tool" : "Script path"}
                >
                  {a.kind === "mcp" ? `${a.mcpServer} · ${a.toolName}` : a.scriptPath}
                </span>
                {a.lastRunAt && (
                  <span className="automation-lastrun">
                    last run {relativeTime(a.lastRunAt)}
                    {a.lastRunSessionId && (
                      <>
                        {" · "}
                        <a
                          className="automation-session-link"
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenSession(a.lastRunSessionId!);
                          }}
                          href="#"
                        >
                          open session
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

// ── Run dialog: render the form from the action's inputs, then run ──

function RunDialog({
  action,
  onClose,
  onRan,
}: {
  action: Action;
  onClose: () => void;
  onRan: (sessionId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const i of action.inputs) init[i.name] = i.default ?? "";
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runActionApi(action.id, values, getCurrentUser() || "Anonymous");
      onRan(sessionId);
    } catch (e: any) {
      setError(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div className="automation-form">
      <div className="automation-form-title">Run: {action.name}</div>
      {action.description && <div className="automation-prompt">{action.description}</div>}

      {action.inputs.length === 0 && (
        <div className="page-sub">This action takes no inputs.</div>
      )}

      {action.inputs.map((input) => (
        <label key={input.name}>
          {input.label || input.name}
          {input.required ? " *" : ""}
          {input.type === "select" ? (
            <select
              value={values[input.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            >
              <option value="">—</option>
              {(input.options || []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : input.type === "boolean" ? (
            <select
              value={values[input.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            >
              <option value="">false</option>
              <option value="true">true</option>
            </select>
          ) : (
            <input
              className="mono-input"
              type={input.type === "number" ? "number" : "text"}
              value={values[input.name] ?? ""}
              placeholder={input.hint || ""}
              onChange={(e) => setValues((v) => ({ ...v, [input.name]: e.target.value }))}
            />
          )}
          {input.hint && <span className="page-sub">{input.hint}</span>}
        </label>
      ))}

      {action.confirm && (
        <div className="page-sub" style={{ color: "var(--warn, #c47f00)" }}>
          ⚠ This action runs against prod. Double-check the values before running.
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn-create" style={{ padding: "8px 22px" }} onClick={run} disabled={busy}>
          {busy ? "Starting…" : action.confirm ? "Confirm & run" : "Run"}
        </button>
      </div>
    </div>
  );
}

// ── Create form: register a repo script ──

const INPUT_TYPES: ActionInputType[] = ["text", "number", "select", "boolean"];

function ActionForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"repo" | "mcp">("repo");
  const [repo] = useState("tella-fusion");
  const [scriptPath, setScriptPath] = useState("");
  const [argMode, setArgMode] = useState<"positional" | "env">("positional");
  const [mcpServer, setMcpServer] = useState("TellaInternalSupportMCP");
  const [toolName, setToolName] = useState("");
  const [confirmFlag, setConfirmFlag] = useState(true);
  const [inputs, setInputs] = useState<ActionInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detect() {
    if (!scriptPath.trim()) return;
    setDetecting(true);
    setError(null);
    try {
      const res = await introspectActionApi(repo, scriptPath.trim());
      setInputs(res.inputs);
      setArgMode(res.argMode);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setDetecting(false);
    }
  }

  function addInput() {
    setInputs((arr) => [...arr, { name: "", label: "", type: "text", required: true }]);
  }
  function updateInput(idx: number, patch: Partial<ActionInput>) {
    setInputs((arr) => arr.map((i, n) => (n === idx ? { ...i, ...patch } : i)));
  }
  function removeInput(idx: number) {
    setInputs((arr) => arr.filter((_, n) => n !== idx));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await createActionApi({
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        inputs: inputs.filter((i) => i.name.trim()),
        confirm: confirmFlag,
        createdBy: getCurrentUser() || "Anonymous",
        ...(kind === "repo"
          ? { repo, scriptPath: scriptPath.trim(), argMode }
          : { mcpServer: mcpServer.trim(), toolName: toolName.trim() }),
      });
      onCreated();
    } catch (e: any) {
      setError(e.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div className="automation-form">
      <div className="automation-form-title">New action</div>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Make Michiel editor" />
      </label>

      <label>
        Description (optional)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Grant a user EDITOR access to a story"
        />
      </label>

      <label>
        Type
        <select value={kind} onChange={(e) => setKind(e.target.value as "repo" | "mcp")}>
          <option value="repo">Repo script — run a script from a repo</option>
          <option value="mcp">MCP tool — call a tool on an MCP server</option>
        </select>
      </label>

      {kind === "repo" ? (
        <div className="automation-form-row">
          <label>
            Repo
            <select value={repo} disabled>
              <option value="tella-fusion">tella-fusion</option>
            </select>
          </label>
          <label style={{ flex: 2 }}>
            Script path (relative to repo root)
            <input
              className="mono-input"
              value={scriptPath}
              onChange={(e) => setScriptPath(e.target.value)}
              placeholder="packages/scripts/make_michiel_editor.sh"
              onBlur={detect}
            />
          </label>
          <label>
            Arg mode
            <select value={argMode} onChange={(e) => setArgMode(e.target.value as "positional" | "env")}>
              <option value="positional">Positional ($1 $2 …)</option>
              <option value="env">Env vars (NAME=… )</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="automation-form-row">
          <label style={{ flex: 2 }}>
            MCP server
            <input
              className="mono-input"
              value={mcpServer}
              onChange={(e) => setMcpServer(e.target.value)}
              placeholder="TellaInternalSupportMCP"
            />
          </label>
          <label style={{ flex: 2 }}>
            Tool name
            <input
              className="mono-input"
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder="grant_story_editor"
            />
          </label>
        </div>
      )}

      {kind === "mcp" && (
        <div className="page-sub">
          Each input's variable name must match the tool's argument name. The tool runs on its own
          server with its own credentials.
        </div>
      )}

      {kind === "repo" && (
        <div className="automation-form-actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn-small" onClick={detect} disabled={detecting || !scriptPath.trim()}>
            {detecting ? "Detecting…" : "Detect inputs from script"}
          </button>
        </div>
      )}

      <div className="automation-form-title" style={{ fontSize: 14, marginTop: 8 }}>
        Inputs {kind === "mcp" ? "(arg names)" : argMode === "positional" ? "(in order →)" : ""}
      </div>
      {inputs.length === 0 && <div className="page-sub">No inputs — the script runs with no args.</div>}
      {inputs.map((input, idx) => (
        <div className="automation-form-row" key={idx} style={{ alignItems: "flex-end" }}>
          <label>
            Variable name
            <input
              className="mono-input"
              value={input.name}
              onChange={(e) => updateInput(idx, { name: e.target.value })}
              placeholder={argMode === "env" ? "STORY_ID" : "ID"}
            />
          </label>
          <label>
            Label
            <input
              value={input.label || ""}
              onChange={(e) => updateInput(idx, { label: e.target.value })}
              placeholder="Story ID"
            />
          </label>
          <label>
            Type
            <select
              value={input.type}
              onChange={(e) => updateInput(idx, { type: e.target.value as ActionInputType })}
            >
              {INPUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "0 0 auto" }}>
            Required
            <input
              type="checkbox"
              checked={!!input.required}
              onChange={(e) => updateInput(idx, { required: e.target.checked })}
            />
          </label>
          <button className="btn-small btn-small-danger" onClick={() => removeInput(idx)}>
            ✕
          </button>
        </div>
      ))}
      <div className="automation-form-actions" style={{ justifyContent: "flex-start" }}>
        <button className="btn-small" onClick={addInput}>
          + Add input
        </button>
      </div>

      <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={confirmFlag}
          onChange={(e) => setConfirmFlag(e.target.checked)}
        />
        Require a confirm before running (recommended for anything touching prod)
      </label>

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleSave}
          disabled={
            saving ||
            !name.trim() ||
            (kind === "repo" ? !scriptPath.trim() : !mcpServer.trim() || !toolName.trim())
          }
        >
          {saving ? "Saving…" : "Create action"}
        </button>
      </div>
    </div>
  );
}
