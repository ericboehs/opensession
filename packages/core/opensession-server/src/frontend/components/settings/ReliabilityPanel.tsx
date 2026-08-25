import { useEffect, useState } from "react";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minH14: {
			minHeight: "56px"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap3: {
			gap: "12px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	px3: {
			paddingInline: "12px"
	},
	py2: {
			paddingBlock: "8px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	shrink0: {
			flexShrink: "0"
	},
	gap2: {
			gap: "8px"
	},
	minH10: {
			minHeight: "40px"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	},
	bgButton: {
			backgroundColor: "var(--button-surface)"
	},
	textSm: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-sm--line-height))"
	},
	transitionTransform: {
			transitionProperty: "transform,translate,scale,rotate",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
});

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
  const load = async () => {
    const response = await fetch(`${API_BASE}/system/session-kernel/dead-letters?limit=100&offset=0`);
    if (!response.ok) throw new Error(`Could not load failed deliveries (${response.status})`);
    setBody(await response.json() as ResponseBody);
    setError(null);
  };
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
            <div key={`${entry.timerId ? "timer" : "outbox"}:${entry.sessionId}:${entry.timerId || entry.id}`} {...mergeStylexProps("last:border-b-0 phone:items-start phone:flex-col", sx.flex, sx.minH14, sx.itemsCenter, sx.gap3, sx.borderB, sx.borderLine, sx.px3, sx.py2)}>
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <div {...stylex.props(sx.truncate, sx.fontMedium, sx.textFg, typography.itemTitle)}>{entry.kind}</div>
                <div {...stylex.props(sx.truncate, sx.textDim, typography.meta)}>{entry.lastError || "Delivery failed"} · {entry.attempts} attempts</div>
              </div>
              <div {...mergeStylexProps("phone:w-full", sx.flex, sx.shrink0, sx.gap2)}>
                <button {...mergeStylexProps("active:scale-[0.96]", sx.minH10, sx.roundedMd, sx.bgButton, sx.px3, sx.textSm, sx.textFg, sx.transitionTransform)} onClick={() => void change(entry, "retry").catch((cause) => setError(String(cause)))}>Retry</button>
                <button {...mergeStylexProps("text-danger hover:bg-hover active:scale-[0.96] transition-[background-color,scale]", sx.minH10, sx.roundedMd, sx.px3, sx.textSm)} onClick={() => void change(entry, "discard").catch((cause) => setError(String(cause)))}>Discard</button>
              </div>
            </div>
          ))}
        </SettingCard>
      )}
      {body?.nextOffset !== undefined && (
        <button {...mergeStylexProps("active:scale-[0.96]", sx.minH10, sx.roundedMd, sx.bgButton, sx.px3, sx.textSm, sx.textFg, sx.transitionTransform)} onClick={() => void loadMore().catch((cause) => setError(String(cause)))}>Load more</button>
      )}
      <SettingsGroupLabel>Pending sends</SettingsGroupLabel>
      {pendingSends.length === 0 ? (
        <EmptyState title="No pending sends">Every saved command has reached the server.</EmptyState>
      ) : (
        <SettingCard>
          {pendingSends.map(({ command, outbox }) => (
            <div key={command.requestId} {...mergeStylexProps("last:border-b-0 phone:items-start phone:flex-col", sx.flex, sx.minH14, sx.itemsCenter, sx.gap3, sx.borderB, sx.borderLine, sx.px3, sx.py2)}>
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>{command.type}</div>
                <div {...stylex.props(sx.truncate, sx.textDim, typography.meta)}>{command.requestId}</div>
              </div>
              <div {...mergeStylexProps("phone:w-full", sx.flex, sx.shrink0, sx.gap2)}>
                <button {...mergeStylexProps("active:scale-[0.96]", sx.minH10, sx.roundedMd, sx.bgButton, sx.px3, sx.textSm, sx.textFg, sx.transitionTransform)} onClick={() => window.dispatchEvent(new Event("opensession-command-outbox-retry"))}>Retry</button>
                <button {...mergeStylexProps("text-danger hover:bg-hover active:scale-[0.96] transition-[background-color,scale]", sx.minH10, sx.roundedMd, sx.px3, sx.textSm)} onClick={() => {
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
