/**
 * Monitor loops — cron-scheduled backstage automations that periodically check the
 * health of the VPS that hosts Michael and ALARM to Slack when something is wrong.
 * Unlike sweep loops (which open PRs), monitors only observe and notify.
 *
 * Anti-spam is by convention, reusable for any monitor:
 *   Before alarming, the run reads recent messages in the alarm channel and skips
 *   anything it already alarmed about that's still ongoing — so a problem that
 *   persists across runs doesn't re-ping the channel every cycle. It only posts for
 *   a genuinely NEW problem (or one that recovered and recurred), and stays silent
 *   when everything is healthy.
 *
 * Adding a monitor = adding a config to MONITORS. Seeded create-if-absent on startup
 * so your UI edits (prompt/schedule/enabled) are preserved.
 */
import { personaName } from "../../server/config";
import { listAutomations, createAutomation } from "../../server/automations";

export interface MonitorConfig {
  /** Stable seed key (so we don't re-create it every startup). */
  eventKey: string;
  name: string;
  /** Slack channel ID to alarm in. */
  alarmChannel: string;
  /** 5-field UTC cron (server is UTC). */
  schedule: string;
  mcpServers: string[];
  model: string;
  /** What to check + the thresholds that count as a problem. */
  checks: string;
}

export function buildMonitorPrompt(cfg: MonitorConfig): string {
  return `You are Michael, running the "${cfg.name}" health check on the VPS that hosts you (it runs Tella's OpenSession server — the systemd unit is \`opensession.service\` — plus the GitHub PR agent, the Slack agent, and your sweep loops).

Your job: detect real problems and alarm in Slack. Do NOT change anything on the box — this is observe-and-notify only. When everything is healthy, do nothing and say nothing.

Permissions note: this run is read-only ask mode on the opencode engine, where unattended runs get NO bash/shell tool — that is expected, not a malfunction; the checks below go through the webfetch tool. Never delegate a check to the task/subagent tool (subagents here have no shell either, so a delegated check silently fails). Posting your alarm to Slack via the Slack MCP is the explicit purpose of this run and is fully allowed — do NOT refuse it on "read-only" grounds.

## 1. Run the checks
${cfg.checks}

## Monitor-broken rule
If a check cannot be executed at all (tool unavailable/denied, expected data missing from a response), the monitor itself is broken. That is alarm-worthy exactly once: follow the dedup step below, and if the channel does not already have a recent monitor-broken alert, post ONE message saying which tool or field was unavailable so a human can fix the automation. Never report a check you could not run as if it had passed.

## 2. Decide what's a problem
Only treat something as a problem if it's clearly abnormal or past a threshold above — not transient noise. If you're unsure whether something is actionable, lean toward NOT alarming (a noisy monitor gets ignored). If a metric is borderline, note it but don't alarm.

## 3. Avoid alarm spam (do this BEFORE posting)
Read the recent messages in the alarm channel with the Slack MCP: \`conversations_history\` on channel \`${cfg.alarmChannel}\` (last ~30 messages). If you ALREADY alarmed about the same problem recently and it's still ongoing, do NOT post again — staying quiet is correct. Only post for a problem that is genuinely NEW since your last alarm, or one that had recovered and has now recurred.

## 4. Alarm (only if there's a new problem)
Post ONE concise message to channel \`${cfg.alarmChannel}\` via the Slack MCP \`conversations_add_message\`. Format:
- Start with "🚨 Michael health alert:" (always say it's you, Michael).
- For each problem: the metric, its current value, the threshold it crossed, and a one-line likely cause / what to check. Use the disk-hog / log-size output to say *what* is eating space when it's a disk alarm.
- If multiple problems, cover them all in the one message (don't post several).
Keep it short and scannable — a human on a phone should grasp it in a glance.

## 5. If everything is healthy
Do nothing: no Slack message, no "all good" post. Silence is the healthy signal. (Just end your turn with a one-line internal summary of what you checked and that all was nominal.)`;
}

const MONITORS: MonitorConfig[] = [
  {
    eventKey: "monitor:michael-health",
    name: "Michael Health Monitor",
    alarmChannel: "C0AFQ7PV057", // #michael-tinker
    schedule: "*/30 * * * *", // every 30 minutes
    mcpServers: ["slack"],
    model: "claude-sonnet-4-6", // routine check — cheap model is plenty
    checks:
      "Fetch `http://127.0.0.1:3850/opensession/api/health` with the webfetch tool. This single response contains everything:\n" +
      "- **Service up**: an HTTP 200 JSON response with `\"ok\": true` means the OpenSession server is alive. PROBLEM (service down) = connection refused / timeout / non-200 / ok not true — the single most important thing this monitor watches. If the fetch fails you also get no metrics; alarm the outage and skip the rest. (If instead the webfetch TOOL itself refuses to run — a permissions/policy error rather than a network failure — that is a monitor problem, not an outage: see the monitor-broken rule, and do NOT report the service as down.)\n" +
      "- **Disk** (`system.disk`, the `/` mount): PROBLEM if `usedPct` >= 85 or `availGb` < 5. This box accumulates worktrees, session files, audit logs, and bun caches, so disk is the most likely failure. For a disk alarm, name the usual suspects (worktrees, session stores, audit logs, bun caches) so a human knows where to look first.\n" +
      "- **Memory** (`system.memory`): PROBLEM if `availablePct` < 5, or `swapUsedGb` is large (several GB) while `availablePct` is also low.\n" +
      "- **CPU load** (`system.load`): PROBLEM if the `5m` AND `15m` load averages are both sustained well above `cores` (e.g. > 2x cores). A transient `1m` spike alone is NOT a problem.\n" +
      "- **Agents** (`agents`): each agent reports a status; note anything not operational, but only alarm if it's clearly broken, not merely idle.\n" +
      "- If `system` is missing or carries an `error` field, treat that as monitor-broken, not as a host problem.",
  },
];

/** Seed the monitor loops as automations (create-if-absent; preserves UI edits). */
export function ensureMonitors(): void {
  for (const mon of MONITORS) {
    if (listAutomations().some((a) => a.eventKey === mon.eventKey)) continue;
    const created = createAutomation({
      name: mon.name,
      prompt: buildMonitorPrompt(mon),
      schedule: mon.schedule,
      mode: "ask", // observe-only: no worktree, no Write/Edit
      createdBy: `${personaName()} (loops)`,
      eventKey: mon.eventKey,
      mcpServers: mon.mcpServers,
      model: mon.model,
    });
    if ("error" in created) {
      console.error(`[loops] Failed to seed monitor "${mon.name}":`, created.error);
    } else {
      console.log(`[loops] Seeded monitor "${mon.name}" (${created.id})`);
    }
  }
}
