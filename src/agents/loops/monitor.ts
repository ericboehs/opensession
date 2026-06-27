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
  return `You are Michael, running the "${cfg.name}" health check on the VPS that hosts you (it runs Tella's backstage service, the GitHub PR agent, the Slack agent, and your sweep loops).

Your job: detect real problems and alarm in Slack. Do NOT change anything on the box — this is observe-and-notify only. When everything is healthy, do nothing and say nothing.

Permissions note: this run is read-only with respect to the codebase, filesystem, and git — never modify/commit anything, and the shell commands below are all read-only. BUT posting your alarm to Slack via the Slack MCP is the explicit purpose of this run and is fully allowed — do NOT refuse it on "read-only" grounds.

## 1. Run the checks (use the Bash tool; these are read-only commands)
${cfg.checks}

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
      "- **Disk space**: `df -h /` and `df -h` (all mounts). PROBLEM if any real mount (especially `/`) is at or above 85% used, or has under ~5GB free. This box accumulates worktrees, session files, audit logs, and bun caches, so disk is the most likely failure.\n" +
      "- **Memory**: `free -h`. PROBLEM if available memory is under ~5% of total, or swap is heavily in use (lots of swap used with low free).\n" +
      "- **CPU load**: `uptime` (1/5/15-min load average) against core count from `nproc`. PROBLEM if the 5- and 15-min load averages are both sustained well above the core count (e.g. > 2× cores) — a single transient 1-min spike is NOT a problem.\n" +
      "- **Backstage service**: `systemctl is-active backstage`. PROBLEM if it is anything other than `active`. (If permission is denied, note it and move on — don't alarm on the permission error itself.)\n" +
      "- **Disk hogs (run only to explain a disk alarm)**: `du -sh /home/ubuntu/worktrees /home/ubuntu/.backstage-sessions /home/ubuntu/.backstage-audit /home/ubuntu/.cache 2>/dev/null` and `ls -lhS /home/ubuntu/projects/tella-backstage/*.log 2>/dev/null | head`. Use this to name what's consuming space.\n" +
      "- Anything else you notice that's clearly broken (e.g. a mount missing, a runaway process in `top -bn1 | head -15`).",
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
      createdBy: "Michael (loops)",
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
