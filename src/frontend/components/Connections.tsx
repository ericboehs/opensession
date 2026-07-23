import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState, useCallback } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconDotsHorizontal, IconTrash, IconSliders, IconHistory, IconPlus } from "./icons";
import { IconTile, displayName } from "./BrandTile";
import { AGENT_NAME, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "unreachable" | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (absent = everyone). */
  allowedUsers?: string[];
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

const STATUS_META: Record<McpConnection["status"], { label: string; dot: string; bad?: boolean }> = {
  connected: { label: "Connected", dot: "var(--green)" },
  ready: { label: "Ready", dot: "var(--green)" },
  "needs-env": { label: "Needs setup", dot: "var(--yellow)", bad: true },
  unreachable: { label: "Unreachable", dot: "var(--red)", bad: true },
  missing: { label: "Missing", dot: "var(--red)", bad: true },
};

const MCP_BLURBS: Record<string, string> = {
  linear: "Issues & projects — read and update Linear",
  plain: "Customer support threads from Plain",
  sentry: "Errors and performance issues",
  workos: "User & organization admin",
  tinybird: "Analytics queries over product events",
  stripe: "Billing, subscriptions & refunds",
  amplitude: "Product analytics events",
  grafana: "Dashboards, logs & metrics",
  incident: "incident.io — incidents & on-call",
  slack: "Post & read Slack messages",
  ahrefs: "SEO, keywords & backlink data",
  github: "Repos, issues & pull requests",
  circle: "Community & support workspace",
  tellainternalsupportmcp: "Tella's internal support investigation tools",
};

const AGENT_BLURBS: Record<string, string> = {
  slack: "Mentions & worktree channels in Slack",
  linear: "Delegated Linear issues become sessions",
  plain: "Support escalations from Plain",
  stripe: "Inbound billing events",
  "grafana-poller": "Polls Grafana alerts into sessions",
  github: "Inbound repository events",
};

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9" rx="2" fill="currentColor" opacity="0.9" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  );
}

function StatusChip({ label, dot }: { label: string; dot: string }) {
  return (
    <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-dim">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {label}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 mt-7 text-xs font-bold tracking-[-0.01em] text-faint">
      {children}
    </div>
  );
}

export function Connections() {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections${force ? "?refresh=1" : ""}`);
      if (res.ok) setData(await res.json());
    } catch {}
    setRefreshing(false);
  }, []);

  useEffect(() => {
    document.title = docTitle("Connections");
    load();
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  async function handleRemove(name: string) {
    if (!confirm(`Remove MCP server "${name}"? New sessions will no longer get its tools.`)) return;
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load(true);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleRestrict(s: McpConnection) {
    const current = (s.allowedUsers || []).join(", ");
    const answer = prompt(
      `Restrict "${s.name}" to these people (comma-separated names, e.g. "Michiel, Grant").\n` +
        `Leave blank to make it available to everyone.`,
      current,
    );
    if (answer === null) return; // cancelled
    const allowedUsers = answer
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedUsers }),
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
            What {AGENT_NAME} is wired into — inbound agents and the MCP tools every session can use.
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-md border border-line-strong px-3 py-2 text-[13px] font-medium text-dim transition-colors hover:border-faint hover:text-fg disabled:opacity-40"
            onClick={() => load(true)}
            disabled={refreshing}
          >
            <IconHistory size={16} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Checking…" : "Re-check"}
          </button>
          <button
            className="flex items-center gap-1 rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-[filter] hover:brightness-110"
            onClick={() => setShowAdd(true)}
          >
            <IconPlus size={16} />
            Add MCP server
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
          <SectionHeading>Agents — how work reaches {AGENT_NAME}</SectionHeading>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {Object.entries(data.agents).map(([name, health]) => {
              const ok = health?.status === "operational";
              const count = typeof health?.activeSessions === "number" ? health.activeSessions : null;
              return (
                <div
                  key={name}
                  className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3.5"
                >
                  <div className="flex items-center gap-2.5">
                    <IconTile name={name} size={30} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                      {displayName(name)}
                    </span>
                    <StatusChip
                      label={ok ? "Operational" : String(health?.status || "down")}
                      dot={ok ? "var(--green)" : "var(--red)"}
                    />
                  </div>
                  <div className="text-xs leading-snug text-dim">
                    {AGENT_BLURBS[name] || "Inbound agent"}
                  </div>
                  {count !== null && (
                    <div className="text-xs text-faint">
                      {count.toLocaleString()} active session{count === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <SectionHeading>MCP servers — tools inside every session</SectionHeading>
          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            {data.mcpServers.map((s, i) => {
              const meta = STATUS_META[s.status];
              const restricted = !!s.allowedUsers?.length;
              return (
                <div
                  key={s.name}
                  className={cn(
                    "group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/50",
                    i > 0 && "border-t border-line",
                  )}
                >
                  <IconTile name={s.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-fg">
                        {displayName(s.name)}
                      </span>
                      {restricted && (
                        <span
                          className="flex flex-shrink-0 items-center gap-1 rounded-full bg-active px-1.5 py-0.5 text-[10.5px] font-medium text-dim"
                          title={`Only these people's sessions get this server: ${s.allowedUsers!.join(", ")}`}
                        >
                          <LockIcon /> {s.allowedUsers!.join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-dim">
                      {MCP_BLURBS[s.name] || "MCP server"}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                      <span className="rounded bg-active px-1.5 py-px font-mono">{s.transport}</span>
                      <span className="truncate font-mono" title={s.target}>{s.target}</span>
                    </div>
                    {meta.bad && s.detail && (
                      <div className="mt-1 truncate font-mono text-[11px] text-red" title={s.detail}>
                        {s.detail}
                      </div>
                    )}
                  </div>
                  <StatusChip label={meta.label} dot={meta.dot} />
                  <Menu.Root>
                    <Menu.Trigger
                      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-[color,opacity,background] hover:bg-active hover:text-fg group-hover:opacity-100 data-[popup-open]:bg-active data-[popup-open]:text-fg data-[popup-open]:opacity-100"
                      aria-label={`Manage ${s.name}`}
                    >
                      <IconDotsHorizontal size={18} />
                    </Menu.Trigger>
                    <Menu.Popup align="end" sideOffset={4}>
                      <Menu.Item onClick={() => handleRestrict(s)}>
                        <IconSliders size={16} className="text-faint" />
                        {restricted ? "Edit access" : "Restrict access"}
                      </Menu.Item>
                      <Menu.Item
                        onClick={() => handleRemove(s.name)}
                        className="text-red data-[highlighted]:bg-red-soft"
                      >
                        <IconTrash size={16} />
                        Remove server
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Root>
                </div>
              );
            })}
          </div>

          <GithubAccounts />

          <PlainRouter />

          <div className="conn-footnote">
            Changes apply to new session runs immediately (config is read per run). In a session
            transcript, MCP tool calls show up tagged with their server name.
          </div>
        </>
      )}
    </div>
  );
}

interface GithubAuthData {
  enabled: boolean;
  clientIdConfigured: boolean;
  accounts: { login: string; name?: string; connectedAt: string; scopes?: string }[];
  team: { name: string; github: string; connected: boolean; canManage: boolean }[];
}

interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/**
 * GitHub user auth — opt-in per-user tokens so interactive sessions open PRs
 * as the actual session owner instead of the bot. Connect runs GitHub's
 * device flow: show a code, the person enters it on github.com, we poll until
 * GitHub hands over their token (stored server-side, never shown here).
 */
function GithubAccounts() {
  const [data, setData] = useState<GithubAuthData | null>(null);
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [flowState, setFlowState] = useState<"idle" | "starting" | "waiting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github`);
      if (res.ok) setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the device flow until GitHub reports authorized / expired.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/connections/github/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: flow.deviceCode }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (body.status === "ok") {
          setFlow(null);
          setFlowState("idle");
          setJustConnected(body.login);
          load();
          return;
        }
        if (body.status === "slow_down") intervalMs = Math.max(body.interval, 5) * 1000;
        if (body.status === "error") {
          setError(body.error);
          setFlow(null);
          setFlowState("idle");
          return;
        }
      } catch {}
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, load]);

  async function startConnect() {
    setError(null);
    setJustConnected(null);
    setFlowState("starting");
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/github/device`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setFlow(body);
      setFlowState("waiting");
    } catch (e: any) {
      setError(e.message);
      setFlowState("idle");
    }
  }

  async function disconnect(login: string) {
    if (!confirm(`Disconnect @${login}? Your GitHub actions will be unavailable until you reconnect.`)) return;
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/github/account/${encodeURIComponent(login)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (!data) return null;
  const active = data.enabled && data.clientIdConfigured;

  return (
    <>
      <SectionHeading>GitHub accounts — PRs as yourself</SectionHeading>
      {error && (
        <div className="form-error" onClick={() => setError(null)}>{error}</div>
      )}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex items-center gap-3 px-4 py-3">
          <IconTile name="github" size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg">Per-user GitHub auth</div>
            <div className="text-xs leading-snug text-dim">
              {active
                ? "Interactive sessions of a connected teammate open PRs as their own GitHub account. Everyone else (and all automations) keeps the bot."
                : "Off — sessions open PRs as the bot account. Opt in via config: integrations.github { userPrAuth: true, oauthClientId } in ~/.opensession/config.json."}
            </div>
          </div>
          <StatusChip
            label={active ? "Enabled" : data.enabled ? "Missing client id" : "Disabled"}
            dot={active ? "var(--green)" : "var(--yellow)"}
          />
          {active && flowState !== "waiting" && (
            <button
              className="flex-shrink-0 rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium text-dim transition-colors hover:border-faint hover:text-fg disabled:opacity-40"
              onClick={startConnect}
              disabled={flowState === "starting"}
            >
              {flowState === "starting" ? "Starting…" : "Connect account"}
            </button>
          )}
        </div>

        {flow && (
          <div className="border-t border-line px-4 py-3 text-sm">
            Enter code{" "}
            <span className="rounded bg-active px-2 py-0.5 font-mono text-[15px] font-bold tracking-[0.12em] text-fg">
              {flow.userCode}
            </span>{" "}
            at{" "}
            <a href={flow.verificationUri} target="_blank" rel="noreferrer" className="text-accent underline">
              {flow.verificationUri}
            </a>
            <span className="ml-2 text-xs text-dim">
              Sign in as the account you want to connect — waiting for GitHub…
            </span>
            <button
              className="ml-3 text-xs text-faint underline"
              onClick={() => {
                setFlow(null);
                setFlowState("idle");
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {justConnected && (
          <div className="border-t border-line px-4 py-2.5 text-xs text-dim">
            Connected <span className="font-medium text-fg">@{justConnected}</span>. Their new
            session runs now open PRs as this account.
          </div>
        )}

        {active &&
          data.team.map((m) => {
            const account = data.accounts.find(
              (a) => a.login.toLowerCase() === m.github.toLowerCase(),
            );
            return (
              <div key={m.github} className="flex items-center gap-3 border-t border-line px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-fg">{m.name}</span>
                  <span className="ml-2 font-mono text-xs text-faint">@{m.github}</span>
                </div>
                {account && (
                  <span className="text-[11px] text-faint">
                    since {new Date(account.connectedAt).toLocaleDateString()}
                  </span>
                )}
                <StatusChip
                  label={m.connected ? "Connected" : "Not connected"}
                  dot={m.connected ? "var(--green)" : "var(--line-strong, var(--text-faint))"}
                />
                {m.connected && m.canManage && (
                  <button
                    className="text-xs text-faint underline hover:text-red"
                    onClick={() => disconnect(m.github)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </>
  );
}

interface ModelInfo {
  id: string;
  provider: "claude" | "codex";
  label: string;
  aliases: string[];
}

/**
 * Plain triage router — the pre-triage classifier that spam-gates new tickets
 * and routes very basic asks (simple refunds, how-do-I) to a cheaper model,
 * keeping Fable for tickets that benefit from real investigation. The prompt
 * is editable here; the JSON output contract is enforced in code.
 */
function PlainRouter() {
  const [cfg, setCfg] = useState<{
    prompt: string;
    isCustom: boolean;
    basicModel: string;
    defaultPrompt: string;
    defaultBasicModel: string;
  } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/connections/plain-router`)
      .then((r) => r.json())
      .then((b) => {
        setCfg(b);
        setDraft(b.prompt);
      })
      .catch(() => {});
    fetch(`${BASE_PATH}/api/models`)
      .then((r) => r.json())
      .then((b) => setModels((b.models || []).filter((m: ModelInfo) => m.provider === "claude")))
      .catch(() => {});
  }, []);

  async function save(patch: { prompt?: string; basicModel?: string }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/connections/plain-router`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setCfg((c) => (c ? { ...c, ...body } : c));
      if ("prompt" in patch) setDraft(body.prompt);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e.message);
    }
    setSaving(false);
  }

  if (!cfg) return null;
  const dirty = draft !== cfg.prompt;

  return (
    <>
      <SectionHeading>Plain triage router — spam gate + model routing</SectionHeading>
      {error && (
        <div className="form-error" onClick={() => setError(null)}>{error}</div>
      )}
      <div className="conn-card" style={{ maxWidth: 720 }}>
        <div className="conn-blurb">
          Every new Plain ticket goes through one cheap Haiku call before triage: spam is skipped
          entirely, a very basic ask (simple refund, how-do-I) runs triage on the model below, and
          everything else runs on the triage automation's own model. Router errors fail open to
          full triage. Applies to the next ticket — no restart.
        </div>
        <div className="conn-detail" style={{ alignItems: "center", gap: 10 }}>
          <span style={{ whiteSpace: "nowrap" }}>Model for basic tickets:</span>
          <select
            value={cfg.basicModel}
            disabled={saving}
            onChange={(e) => save({ basicModel: e.target.value })}
            aria-label="Model for basic tickets"
            style={{ flex: 1, minWidth: 0 }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          spellCheck={false}
          aria-label="Routing prompt"
          style={{ width: "100%", fontFamily: "var(--mono, monospace)", fontSize: 12, marginTop: 8 }}
        />
        <div className="conn-detail" style={{ alignItems: "center", gap: 10, marginTop: 6 }}>
          <button
            className="btn btn-primary"
            disabled={saving || !dirty}
            onClick={() => save({ prompt: draft })}
          >
            {saving ? "Saving…" : "Save prompt"}
          </button>
          <button
            className="btn"
            disabled={saving || (!cfg.isCustom && !dirty)}
            onClick={() => save({ prompt: "" })}
          >
            Reset to default
          </button>
          <span className="conn-target">
            {dirty
              ? "Unsaved changes"
              : savedAt
                ? "Saved."
                : cfg.isCustom
                  ? "Custom prompt active"
                  : "Using the built-in default"}
          </span>
        </div>
      </div>
    </>
  );
}

function AddMcpForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
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

      const allowed = allowedUsers.split(",").map((u) => u.trim()).filter(Boolean);

      const res = await fetch(`${BASE_PATH}/api/connections/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
          env: transport === "stdio" ? envObj : undefined,
          allowedUsers: allowed.length ? allowed : undefined,
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

      <label>
        Allowed users (optional, comma-separated — leave blank for everyone)
        <input
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Michiel, Grant"
        />
      </label>

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
