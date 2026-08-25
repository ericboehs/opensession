import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../lib/api";
import {
  localCommandScope,
  wsCommandOutboxForScope,
} from "../../lib/ws-command-outbox";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingsGroupLabel,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";

type DeadLetter = {
  id?: number;
  sessionId: string;
  timerId?: string;
  effectId?: string;
  kind: string;
  attempts: number;
  lastError?: string;
  deadLetteredAt?: number;
};
type ResponseBody = { timers: DeadLetter[]; outbox: DeadLetter[]; nextOffset?: number };

export function ReliabilityPanel({ initialBody = null }: { initialBody?: ResponseBody | null }) {
  const [body, setBody] = useState<ResponseBody | null>(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [pendingVersion, setPendingVersion] = useState(0);
  const commandScope = (() => {
    try { return localStorage.getItem("opensession-command-scope") || localCommandScope(); }
    catch { return localCommandScope(); }
  })();
  const clientOutbox = wsCommandOutboxForScope(commandScope);
  const provisionalOutbox = wsCommandOutboxForScope(localCommandScope());
  const pendingById = new Map<string, { command: ReturnType<typeof clientOutbox.pending>[number]; outbox: typeof clientOutbox }>();
  for (const outbox of new Set([clientOutbox, provisionalOutbox]))
    for (const command of outbox.pending())
      pendingById.set(command.requestId, { command, outbox });
  const pendingSends = [...pendingById.values()];
  // Stable identity: only setters are captured.
  const load = useCallback(async () => {
    const response = await fetch(`${API_BASE}/system/session-kernel/dead-letters?limit=100&offset=0`);
    if (!response.ok) throw new Error(`Could not load failed deliveries (${response.status})`);
    setBody(await response.json() as ResponseBody);
    setError(null);
  }, []);
  const loadMore = async () => {
    if (!body?.nextOffset) return;
    const response = await fetch(`${API_BASE}/system/session-kernel/dead-letters?limit=100&offset=${body.nextOffset}`);
    if (!response.ok) throw new Error(`Could not load more failed deliveries (${response.status})`);
    const page = await response.json() as ResponseBody;
    setBody({
      timers: [...body.timers, ...page.timers],
      outbox: [...body.outbox, ...page.outbox],
      nextOffset: page.nextOffset,
    });
  };
  useEffect(() => {
    const blocked = () => {
      setError("A pending send could not move into verified storage. Review it below.");
      setPendingVersion((value) => value + 1);
    };
    window.addEventListener("opensession-command-outbox-blocked", blocked);
    void load().catch((cause) => setError(String(cause)));
    const timer = window.setInterval(() => void load().catch(() => {}), 10_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("opensession-command-outbox-blocked", blocked);
    };
  }, [load]);

  const change = async (entry: DeadLetter, action: "retry" | "discard") => {
    if (action === "discard" && !window.confirm("Discard this failed delivery? It will not run again.")) return;
    const payload = entry.timerId
      ? { action, type: "timer", sessionId: entry.sessionId, timerId: entry.timerId }
      : { action, type: "outbox", id: entry.id };
    const response = await fetch(`${API_BASE}/system/session-kernel/dead-letters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Could not ${action} delivery (${response.status})`);
    await load();
  };

  const entries = body ? [...body.timers, ...body.outbox] : [];
  return (
    <SettingsPanel>
      <SettingsHeader
        title="Reliability"
        description="Inspect deliveries that stopped retrying. Retry them or discard work that should not run."
      />
      {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
      <SettingsGroupLabel>Failed deliveries</SettingsGroupLabel>
      {!body ? <SettingCardSkeleton rows={3} label="Loading failed deliveries" /> : entries.length === 0 ? (
        <EmptyState title="No failed deliveries">Timers and external deliveries are running normally.</EmptyState>
      ) : (
        <SettingCard>
          {entries.map((entry) => (
            <div key={`${entry.timerId ? "timer" : "outbox"}:${entry.sessionId}:${entry.timerId || entry.id}`} className="flex min-h-14 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 phone:items-start phone:flex-col">
              <div className="min-w-0 flex-1">
                <div className="truncate text-item-title font-medium text-fg">{entry.kind}</div>
                <div className="truncate text-meta text-dim">{entry.lastError || "Delivery failed"} · {entry.attempts} attempts</div>
              </div>
              <div className="flex shrink-0 gap-2 phone:w-full">
                <button className="min-h-10 rounded-md bg-button px-3 text-sm text-fg active:scale-[0.96] transition-transform" onClick={() => void change(entry, "retry").catch((cause) => setError(String(cause)))}>Retry</button>
                <button className="min-h-10 rounded-md px-3 text-sm text-danger hover:bg-hover active:scale-[0.96] transition-[background-color,scale]" onClick={() => void change(entry, "discard").catch((cause) => setError(String(cause)))}>Discard</button>
              </div>
            </div>
          ))}
        </SettingCard>
      )}
      {body?.nextOffset !== undefined && (
        <button className="min-h-10 rounded-md bg-button px-3 text-sm text-fg active:scale-[0.96] transition-transform" onClick={() => void loadMore().catch((cause) => setError(String(cause)))}>Load more</button>
      )}
      <SettingsGroupLabel>Pending sends</SettingsGroupLabel>
      {pendingSends.length === 0 ? (
        <EmptyState title="No pending sends">Every saved command has reached the server.</EmptyState>
      ) : (
        <SettingCard>
          {pendingSends.map(({ command, outbox }) => (
            <div key={command.requestId} className="flex min-h-14 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 phone:items-start phone:flex-col">
              <div className="min-w-0 flex-1">
                <div className="text-item-title font-medium text-fg">{command.type}</div>
                <div className="truncate text-meta text-dim">{command.requestId}</div>
              </div>
              <div className="flex shrink-0 gap-2 phone:w-full">
                <button className="min-h-10 rounded-md bg-button px-3 text-sm text-fg active:scale-[0.96] transition-transform" onClick={() => window.dispatchEvent(new Event("opensession-command-outbox-retry"))}>Retry</button>
                <button className="min-h-10 rounded-md px-3 text-sm text-danger hover:bg-hover active:scale-[0.96] transition-[background-color,scale]" onClick={() => {
                  if (!window.confirm("Forget this pending send? It may already have reached the server.")) return;
                  outbox.forget(command.requestId);
                  setPendingVersion((value) => value + 1);
                }}>Forget</button>
              </div>
            </div>
          ))}
        </SettingCard>
      )}
      <span hidden>{pendingVersion}</span>
    </SettingsPanel>
  );
}
