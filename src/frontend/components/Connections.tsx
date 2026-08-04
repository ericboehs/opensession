import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState, useCallback } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { InlineAlert, LoadingState } from "../ui/state";
import {
  SettingCard,
  SettingsField,
  SettingsForm,
  SettingsFormActions,
  SettingsFormRow,
  SettingsFormTitle,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
  SettingsSection,
  rowMenuTriggerClasses,
  settingsInputClass,
  settingsSelectClass,
} from "../ui/settings";
import { IconDotsHorizontal, IconTrash, IconSliders, IconHistory, IconPlus } from "./icons";
import { IconTile, displayName } from "./BrandTile";
import { AGENT_NAME, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { ProjectsSection } from "./ProjectsSection";

interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string;
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "needs-auth" | "unreachable" | "missing";
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
  "needs-auth": { label: "Sign in required", dot: "var(--yellow)", bad: true },
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
    <span className="flex flex-shrink-0 items-center gap-1.5 text-label text-dim">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {label}
    </span>
  );
}

export function SectionHeading({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return <SettingsGroupLabel actions={actions}>{children}</SettingsGroupLabel>;
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

  // OAuth grants per HTTP server (mcp-oauth.ts): shared + per-user badges.
  const [oauthByName, setOauthByName] = useState<
    Record<
      string,
      { shared?: { connectedBy?: string }; users: string[]; capable?: boolean }
    >
  >({});
  const loadOauth = useCallback(async (servers: McpConnection[]) => {
    const entries = await Promise.all(
      servers
        .map(async (s) => {
          try {
            const res = await fetch(
              `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth`,
            );
            return res.ok ? ([s.name, await res.json()] as const) : null;
          } catch {
            return null;
          }
        }),
    );
    setOauthByName(Object.fromEntries(entries.filter(Boolean) as any));
  }, []);
  useEffect(() => {
    if (data?.mcpServers) void loadOauth(data.mcpServers);
  }, [data, loadOauth]);

  // Start a browser OAuth flow (workspace-wide or the signed-in user's own
  // account) and open the consent in a new tab; re-poll status for a while
  // so the badge appears once they approve.
  async function handleOauthConnect(s: McpConnection, scope: "shared" | "me") {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      window.open(body.url, "_blank", "noopener");
      let polls = 0;
      const t = setInterval(() => {
        if (++polls > 24 || !data?.mcpServers) return clearInterval(t);
        void loadOauth(data.mcpServers);
      }, 5000);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

  async function handleOauthDisconnect(s: McpConnection, scope: "shared" | "me") {
    try {
      const res = await fetch(
        `${BASE_PATH}/api/connections/mcp/${encodeURIComponent(s.name)}/oauth${scope === "me" ? "?scope=me" : ""}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error((await res.json()).error || `Failed: ${res.status}`);
      if (data?.mcpServers) void loadOauth(data.mcpServers);
    } catch (e: any) {
      setRemoveError(e.message);
    }
  }

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
      `Restrict "${s.name}" to these people (comma-separated configured names, e.g. "Alice, Bob").\n` +
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
    <SettingsPanel>
      <SettingsHeader
        title="Connections"
        description={`What ${AGENT_NAME} is wired into — inbound agents and the MCP tools every session can use.`}
        actions={
          <>
            <Button
              icon={<IconHistory size={16} className={refreshing ? "animate-spin" : ""} />}
              onClick={() => load(true)}
              disabled={refreshing}
            >
              {refreshing ? "Checking…" : "Re-check"}
            </Button>
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setShowAdd(true)}
            >
              Add MCP server
            </Button>
          </>
        }
      />

      {removeError && (
        <InlineAlert onDismiss={() => setRemoveError(null)}>{removeError}</InlineAlert>
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
        <LoadingState>Checking connections…</LoadingState>
      ) : (
        <>
          <SectionHeading>Agents — how work reaches {AGENT_NAME}</SectionHeading>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
            {Object.entries(data.agents).map(([name, health]) => {
              const ok = health?.status === "operational";
              const count = typeof health?.activeSessions === "number" ? health.activeSessions : null;
              return (
                <SettingsSection key={name} className="flex flex-col gap-2 p-3.5">
                  <div className="flex items-center gap-2.5">
                    <IconTile name={name} size={30} />
                    <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
                      {displayName(name)}
                    </span>
                    <StatusChip
                      label={ok ? "Operational" : String(health?.status || "down")}
                      dot={ok ? "var(--green)" : "var(--red)"}
                    />
                  </div>
                  <div className="text-label leading-snug text-dim">
                    {AGENT_BLURBS[name] || "Inbound agent"}
                  </div>
                  {count !== null && (
                    <div className="text-label text-faint">
                      {count.toLocaleString()} active session{count === 1 ? "" : "s"}
                    </div>
                  )}
                </SettingsSection>
              );
            })}
          </div>

          <SectionHeading>MCP servers — tools inside every session</SectionHeading>
          <SettingCard>
            {data.mcpServers.map((s) => {
              const meta = STATUS_META[s.status];
              const restricted = !!s.allowedUsers?.length;
              return (
                <div
                  key={s.name}
                  className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-hover"
                >
                  <IconTile name={s.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-body font-medium text-fg">
                        {displayName(s.name)}
                      </span>
                      {restricted && (
                        <span
                          className="flex flex-shrink-0 items-center gap-1 rounded-full bg-active px-1.5 py-0.5 text-meta font-medium text-dim"
                          title={`Only these people's sessions get this server: ${s.allowedUsers!.join(", ")}`}
                        >
                          <LockIcon /> {s.allowedUsers!.join(", ")}
                        </span>
                      )}
                      {(oauthByName[s.name]?.shared || oauthByName[s.name]?.users.length) ? (
                        <span
                          className="flex flex-shrink-0 items-center gap-1 rounded-full bg-active px-1.5 py-0.5 text-meta font-medium text-green"
                          title={[
                            oauthByName[s.name]?.shared
                              ? `Workspace grant${oauthByName[s.name]!.shared!.connectedBy ? ` (by ${oauthByName[s.name]!.shared!.connectedBy})` : ""}`
                              : null,
                            oauthByName[s.name]!.users.length
                              ? `Personal: ${oauthByName[s.name]!.users.join(", ")}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          OAuth
                          {oauthByName[s.name]?.shared ? " · workspace" : ""}
                          {oauthByName[s.name]!.users.length
                            ? ` · ${oauthByName[s.name]!.users.join(", ")}`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-label text-dim">
                      {MCP_BLURBS[s.name] || "MCP server"}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-meta text-faint">
                      <span className="rounded bg-active px-1.5 py-px">{s.transport}</span>
                      <span className="truncate" title={s.target}>{s.target}</span>
                    </div>
                    {meta.bad && s.detail && (
                      <div className="mt-1 truncate text-meta text-red" title={s.detail}>
                        {s.detail}
                      </div>
                    )}
                  </div>
                  <StatusChip label={meta.label} dot={meta.dot} />
                  <Menu.Root>
                    <Menu.Trigger
                      className={cn(
                        rowMenuTriggerClasses,
                        "opacity-0 transition-[color,opacity,background] group-hover:opacity-100 data-[popup-open]:opacity-100",
                      )}
                      aria-label={`Manage ${s.name}`}
                    >
                      <IconDotsHorizontal size={18} />
                    </Menu.Trigger>
                    <Menu.Popup align="end" sideOffset={4}>
                      {(s.transport === "http" || oauthByName[s.name]?.capable) && (
                        <>
                          <Menu.Item onClick={() => handleOauthConnect(s, "shared")}>
                            <IconPlus size={16} className="text-faint" />
                            {oauthByName[s.name]?.shared
                              ? "Reconnect (workspace)"
                              : "Connect (workspace)"}
                          </Menu.Item>
                          <Menu.Item onClick={() => handleOauthConnect(s, "me")}>
                            <IconPlus size={16} className="text-faint" />
                            Connect my account
                          </Menu.Item>
                          {(oauthByName[s.name]?.shared ||
                            oauthByName[s.name]?.users.length) ? (
                            <Menu.Item
                              onClick={() =>
                                handleOauthDisconnect(
                                  s,
                                  oauthByName[s.name]?.shared ? "shared" : "me",
                                )
                              }
                            >
                              <IconTrash size={16} className="text-faint" />
                              Disconnect OAuth
                            </Menu.Item>
                          ) : null}
                          <Menu.Separator />
                        </>
                      )}
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
          </SettingCard>

          <ProjectsSection />

          <PlainRouter />

          <div className="mt-6 text-supporting text-faint">
            Changes apply to new session runs immediately (config is read per run). In a session
            transcript, MCP tool calls show up tagged with their server name.
          </div>
        </>
      )}
    </SettingsPanel>
  );
}

interface GithubAuthData {
  enabled: boolean;
  clientIdConfigured: boolean;
  accounts: { login: string; name?: string; connectedAt: string; scopes?: string }[];
  team: {
    name: string;
    github: string;
    connected: boolean;
    /** Connected once, but GitHub has since revoked the renewal — reconnecting
     *  is the only fix, so the row says so instead of reading "Connected". */
    needsReconnect?: boolean;
    canManage: boolean;
  }[];
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
/** `personal`: only the signed-in user's own row (the My accounts page);
 *  default shows the whole team roster (admin overview). */
export function GithubAccounts({ personal = false }: { personal?: boolean } = {}) {
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
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingCard>
        <div className="flex items-center gap-3 px-4 py-3">
          <IconTile name="github" size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium text-fg">Per-user GitHub auth</div>
            <div className="text-label leading-snug text-dim">
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
            <Button
              size="sm"
              className="flex-shrink-0"
              onClick={startConnect}
              disabled={flowState === "starting"}
            >
              {flowState === "starting" ? "Starting…" : "Connect account"}
            </Button>
          )}
        </div>

        {flow && (
          <div className="px-4 py-3 text-body">
            Enter code{" "}
            <span className="rounded bg-active px-2 py-0.5 font-mono text-item-title font-bold tracking-[0.12em] text-fg">
              {flow.userCode}
            </span>{" "}
            at{" "}
            <a href={flow.verificationUri} target="_blank" rel="noreferrer" className="text-accent underline">
              {flow.verificationUri}
            </a>
            <span className="ml-2 text-label text-dim">
              Sign in as the account you want to connect — waiting for GitHub…
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => {
                setFlow(null);
                setFlowState("idle");
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        {justConnected && (
          <div className="px-4 py-2.5 text-label text-dim">
            Connected <span className="font-medium text-fg">@{justConnected}</span>. Their new
            session runs now open PRs as this account.
          </div>
        )}

        {active &&
          data.team
            .filter((m) => !personal || m.canManage)
            .map((m) => {
            const account = data.accounts.find(
              (a) => a.login.toLowerCase() === m.github.toLowerCase(),
            );
            return (
              <div key={m.github} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-body font-medium text-fg">{m.name}</span>
                  <span className="ml-2 text-label text-faint">@{m.github}</span>
                </div>
                {account && (
                  <span className="text-meta text-faint">
                    since {new Date(account.connectedAt).toLocaleDateString()}
                  </span>
                )}
                <StatusChip
                  label={
                    m.needsReconnect
                      ? "Reconnect needed"
                      : m.connected
                        ? "Connected"
                        : "Not connected"
                  }
                  dot={
                    m.needsReconnect
                      ? "var(--red)"
                      : m.connected
                        ? "var(--green)"
                        : "var(--line-strong, var(--text-faint))"
                  }
                />
                {m.connected && m.canManage && (
                  <Button
                    size="sm"
                    className="hover:border-red hover:text-red"
                    onClick={() => disconnect(m.github)}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            );
          })}
      </SettingCard>
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
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      <SettingsSection className="min-w-0 max-w-[720px]">
        <div className="mb-2 text-supporting leading-[1.45] text-dim">
          Every new Plain ticket goes through one cheap Haiku call before triage: spam is skipped
          entirely, a very basic ask (simple refund, how-do-I) runs triage on the model below, and
          everything else runs on the triage automation's own model. Router errors fail open to
          full triage. Applies to the next ticket — no restart.
        </div>
        <div className="flex min-w-0 items-center gap-2.5 text-meta text-faint">
          <span className="whitespace-nowrap">Model for basic tickets:</span>
          <select
            className={cn(settingsSelectClass, "min-w-0 flex-1")}
            value={cfg.basicModel}
            disabled={saving}
            onChange={(e) => save({ basicModel: e.target.value })}
            aria-label="Model for basic tickets"
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
          className={cn(settingsInputClass, "mt-2 resize-y text-body")}
        />
        <div className="mt-1.5 flex min-w-0 items-center gap-2.5 text-meta text-faint">
          <Button
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => save({ prompt: draft })}
          >
            {saving ? "Saving…" : "Save prompt"}
          </Button>
          <Button
            disabled={saving || (!cfg.isCustom && !dirty)}
            onClick={() => save({ prompt: "" })}
          >
            Reset to default
          </Button>
          <span className="min-w-0 truncate whitespace-nowrap">
            {dirty
              ? "Unsaved changes"
              : savedAt
                ? "Saved."
                : cfg.isCustom
                  ? "Custom prompt active"
                  : "Using the built-in default"}
          </span>
        </div>
      </SettingsSection>
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
    <SettingsForm className="mb-[18px] flex flex-col gap-3.5">
      <SettingsFormTitle>Add MCP server</SettingsFormTitle>

      <SettingsFormRow>
        <SettingsField>
          Name
          <input className={settingsInputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </SettingsField>
        <SettingsField>
          Transport
          <select className={settingsSelectClass} value={transport} onChange={(e) => setTransport(e.target.value as any)}>
            <option value="http">http — remote MCP endpoint</option>
            <option value="stdio">stdio — local command</option>
          </select>
        </SettingsField>
      </SettingsFormRow>

      {transport === "http" ? (
        <SettingsField>
          URL
          <input
            className={settingsInputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/mcp"
          />
        </SettingsField>
      ) : (
        <>
          <SettingsFormRow>
            <SettingsField>
              Command
              <input
                className={settingsInputClass}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="~/bin/my-mcp"
              />
            </SettingsField>
            <SettingsField>
              Args (space-separated)
              <input
                className={settingsInputClass}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="run /path/to/server.ts"
              />
            </SettingsField>
          </SettingsFormRow>
          <SettingsField>
            Env (KEY=VALUE, one per line — stored in mcp-config.json)
            <textarea
              className={cn(settingsInputClass, "resize-y font-mono")}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"API_KEY=${MY_API_KEY}"}
            />
          </SettingsField>
        </>
      )}

      <SettingsField>
        Allowed users (optional, comma-separated — leave blank for everyone)
        <input
          className={settingsInputClass}
          value={allowedUsers}
          onChange={(e) => setAllowedUsers(e.target.value)}
          placeholder="Alice, Bob"
        />
      </SettingsField>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={saving || !valid}
        >
          {saving ? "Adding…" : "Add server"}
        </Button>
      </SettingsFormActions>
    </SettingsForm>
  );
}
