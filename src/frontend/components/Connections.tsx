import React, { useEffect, useState, useCallback } from "react";

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "unreachable" | "missing";
  detail?: string;
}

interface AgentHealth {
  status?: string;
  activeSessions?: number;
  [key: string]: unknown;
}

interface ConnectionsData {
  mcpServers: McpConnection[];
  agents: Record<string, AgentHealth>;
}

const STATUS_META: Record<McpConnection["status"], { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "green" },
  ready: { label: "Ready", tone: "green" },
  "needs-env": { label: "Needs env", tone: "yellow" },
  unreachable: { label: "Unreachable", tone: "red" },
  missing: { label: "Missing", tone: "red" },
};

const MCP_BLURBS: Record<string, string> = {
  linear: "Issues & projects — sessions can read and update Linear",
  plain: "Customer support threads from Plain",
  sentry: "Errors and performance issues",
  workos: "User & organization admin",
  tinybird: "Analytics queries over product events",
};

const AGENT_BLURBS: Record<string, string> = {
  slack: "Mentions & worktree channels in Slack",
  linear: "Delegated Linear issues become sessions",
  plain: "Support escalations from Plain",
};

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`/backstage/api/connections${force ? "?refresh=1" : ""}`);
      if (res.ok) setData(await res.json());
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => {
    document.title = "Connections — Michael";
    load();
    return () => {
      document.title = "Michael — Tella";
    };
  }, [load]);

  async function handleRemove(name: string) {
    if (!confirm(`Remove MCP server "${name}"? New sessions will no longer get its tools.`)) return;
    try {
      const res = await fetch(`/backstage/api/connections/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  return (
    <div className="connections">
      <div className="page-header">
        <div>
          <h2 className="page-title">Connections</h2>
          <div className="page-sub">
            What Michael is wired into — inbound agents and the MCP tools every session can use.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-small" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? "Checking…" : "↻ Re-check"}
          </button>
          <button className="btn-new-session" style={{ marginTop: 0, padding: "6px 14px" }} onClick={() => setShowAdd(true)}>
            + Add MCP server
          </button>
        </div>
      </div>

      {removeError && (
        <div className="form-error" onClick={() => setRemoveError(null)}>{removeError}</div>
      )}

      {showAdd && (
        <AddMcpForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load(true);
          }}
        />
      )}

      {!data ? (
        <div className="loading">Checking connections…</div>
      ) : (
        <>
          <div className="conn-section-title">Agents — how work reaches Michael</div>
          <div className="conn-grid">
            {Object.entries(data.agents).map(([name, health]) => {
              const ok = health?.status === "operational";
              return (
                <div key={name} className="conn-card">
                  <div className="conn-card-top">
                    <span className={`conn-logo conn-logo-${name}`}>{name.charAt(0).toUpperCase()}</span>
                    <span className="conn-name">{name}</span>
                    <span className={`status-pill status-${ok ? "green" : "red"}`}>
                      {ok ? "Operational" : String(health?.status || "down")}
                    </span>
                  </div>
                  <div className="conn-blurb">{AGENT_BLURBS[name] || "Inbound agent"}</div>
                  {typeof health?.activeSessions === "number" && (
                    <div className="conn-detail">{health.activeSessions} active session{health.activeSessions === 1 ? "" : "s"}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="conn-section-title">MCP servers — tools inside every session</div>
          <div className="conn-grid">
            {data.mcpServers.map((s) => {
              const meta = STATUS_META[s.status];
              return (
                <div key={s.name} className="conn-card">
                  <div className="conn-card-top">
                    <span className={`conn-logo conn-logo-${s.name}`}>{s.name.charAt(0).toUpperCase()}</span>
                    <span className="conn-name">{s.name}</span>
                    <span className={`status-pill status-${meta.tone}`} title={s.detail}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="conn-blurb">{MCP_BLURBS[s.name] || "MCP server"}</div>
                  <div className="conn-detail">
                    <span className="conn-transport">{s.transport}</span>
                    <span className="conn-target" title={s.target}>{s.target}</span>
                  </div>
                  {s.status !== "connected" && s.status !== "ready" && s.detail && (
                    <div className="conn-error">{s.detail}</div>
                  )}
                  <button
                    className="conn-remove"
                    onClick={() => handleRemove(s.name)}
                    title="Remove this MCP server"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>

          <div className="conn-footnote">
            Changes apply to new session runs immediately (config is read per run). In a session
            transcript, MCP tool calls show up tagged with their server name.
          </div>
        </>
      )}
    </div>
  );
}

function AddMcpForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const envObj: Record<string, string> = {};
      for (const line of env.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) throw new Error(`Env line "${trimmed}" must be KEY=VALUE`);
        envObj[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }

      const res = await fetch("/backstage/api/connections/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
          env: transport === "stdio" ? envObj : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      onAdded();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  const valid =
    name.trim() && (transport === "http" ? url.trim() : command.trim());

  return (
    <div className="automation-form" style={{ marginBottom: 18 }}>
      <div className="automation-form-title">Add MCP server</div>

      <div className="automation-form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </label>
        <label>
          Transport
          <select value={transport} onChange={(e) => setTransport(e.target.value as any)}>
            <option value="http">http — remote MCP endpoint</option>
            <option value="stdio">stdio — local command</option>
          </select>
        </label>
      </div>

      {transport === "http" ? (
        <label>
          URL
          <input
            className="mono-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
        </label>
      ) : (
        <>
          <div className="automation-form-row">
            <label>
              Command
              <input
                className="mono-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="/home/ubuntu/bin/my-mcp"
              />
            </label>
            <label>
              Args (space-separated)
              <input
                className="mono-input"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </label>
          </div>
          <label>
            Env (KEY=VALUE, one per line — stored in mcp-config.json)
            <textarea
              className="mono-input"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </label>
        </>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="automation-form-actions">
        <button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          className="btn-create"
          style={{ padding: "8px 22px" }}
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </button>
      </div>
    </div>
  );
}
