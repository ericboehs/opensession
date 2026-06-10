/**
 * Automations: cron-scheduled Michael sessions, Devin-style.
 * Records live in ~/.backstage-automations/<id>.json; each run creates a
 * normal backstage session so it shows up in the sessions list and UI.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { parseCron, cronMatches, nextRun } from "./cron";
import { runClaude } from "./claude-runner";
import { createWorktree, listWorktrees } from "./worktree";
import type { BackstageSessionFile } from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const AUTOMATIONS_DIR = `${HOME}/.backstage-automations`;
const SESSIONS_DIR = `${HOME}/.backstage-sessions`;
const TELLA_FUSION = `${HOME}/projects/tella-fusion`;

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string; // 5-field cron, UTC; "" = webhook/manual only
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret: string; // every automation is also webhook-triggerable
  eventKey?: string; // internal event subscription, e.g. "plain:thread_created"
  /**
   * MCP server allowlist for this automation's runs (least privilege).
   * Omitted = all configured servers, for automations created before this
   * existed. Prefer naming just what the automation actually uses.
   */
  mcpServers?: string[];
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
}

export interface AutomationWithNext extends Automation {
  nextRunAt: string | null;
}

mkdirSync(AUTOMATIONS_DIR, { recursive: true });

// ── Store ────────────────────────────────────────────────────

export function listAutomations(): AutomationWithNext[] {
  const out: AutomationWithNext[] = [];
  for (const file of readdirSync(AUTOMATIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(`${AUTOMATIONS_DIR}/${file}`, "utf-8")) as Automation;
      out.push({
        ...a,
        nextRunAt:
          a.enabled && a.schedule ? nextRun(a.schedule)?.toISOString() || null : null,
      });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getAutomation(id: string): Automation | null {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveAutomation(a: Automation): void {
  writeFileSync(`${AUTOMATIONS_DIR}/${a.id}.json`, JSON.stringify(a, null, 2));
}

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const names = list.filter((s): s is string => typeof s === "string" && !!s.trim());
  // [] is meaningful: no MCP servers at all
  return names.map((s) => s.trim());
}

function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function createAutomation(input: {
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  createdBy: string;
  eventKey?: string;
  mcpServers?: string[];
}): Automation | { error: string } {
  if (!input.name.trim()) return { error: "Name is required" };
  if (!input.prompt.trim()) return { error: "Prompt is required" };
  const schedule = (input.schedule || "").trim();
  if (schedule && !parseCron(schedule)) {
    return { error: `Invalid cron expression: "${schedule}"` };
  }

  const a: Automation = {
    id: `auto-${randomUUIDv7()}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    schedule,
    mode: input.mode === "code" ? "code" : "ask",
    enabled: true,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    webhookSecret: generateSecret(),
    eventKey: (input.eventKey || "").trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
  };
  saveAutomation(a);
  return a;
}

export function updateAutomation(
  id: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "mode" | "enabled" | "eventKey" | "mcpServers">>
): Automation | { error: string } {
  const a = getAutomation(id);
  if (!a) return { error: "Automation not found" };
  if (patch.schedule !== undefined && patch.schedule.trim() && !parseCron(patch.schedule)) {
    return { error: `Invalid cron expression: "${patch.schedule}"` };
  }
  const next = { ...a, ...patch };
  if ("mcpServers" in patch) next.mcpServers = sanitizeMcpList(patch.mcpServers);
  // Backfill secrets for automations created before webhook support
  if (!next.webhookSecret) next.webhookSecret = generateSecret();
  saveAutomation(next);
  return next;
}

export function deleteAutomation(id: string): boolean {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── Runner ───────────────────────────────────────────────────

const runningCounts = new Map<string, number>();

// Automation runs are headless and often driven by untrusted text (e.g.
// customer ticket content), so they must stay read-only toward the customer:
// no replying to or changing the state of a Plain thread. Enforced at the
// tool-permission layer — prompt instructions alone don't constrain a run.
const PLAIN_WRITE_DENIAL =
  "This tool isn't available in automation runs — they are read-only toward the " +
  "customer thread. Put your suggested reply or status change in the internal " +
  "note (mcp__plain__create_note) for a human to act on instead.";
const AUTOMATION_DENIED_TOOLS: Record<string, string> = {
  mcp__plain__reply_to_thread: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_done: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_todo: PLAIN_WRITE_DENIAL,
  mcp__plain__snooze_thread: PLAIN_WRITE_DENIAL,
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
}

export function isAutomationRunning(id: string): boolean {
  return (runningCounts.get(id) || 0) > 0;
}

export async function runAutomation(
  automation: Automation,
  onSessionCreated?: (sessionId: string) => void,
  options?: { trigger?: "cron" | "webhook" | "manual" | "event"; eventContext?: string }
): Promise<void> {
  const trigger = options?.trigger || "manual";
  // Cron/manual runs don't stack; event/webhook runs are per-event, so they may overlap
  const concurrent = trigger === "event" || trigger === "webhook";
  if (!concurrent && isAutomationRunning(automation.id)) {
    console.log(`[automations] "${automation.name}" still running, skipping`);
    return;
  }
  runningCounts.set(automation.id, (runningCounts.get(automation.id) || 0) + 1);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", " ");
  const bksId = `bks-${randomUUIDv7()}`;

  try {
    let cwd = TELLA_FUSION;
    let branch = "";
    if (automation.mode === "code") {
      branch = `auto-${slugify(automation.name)}-${startedAt
        .toISOString()
        .slice(0, 16)
        .replace(/[-T:]/g, "")}`;
      const worktrees = await listWorktrees();
      cwd = worktrees.find((w) => w.branch === branch)?.path || (await createWorktree(branch));
    }

    saveAutomation({
      ...automation,
      lastRunAt: startedAt.toISOString(),
      lastRunSessionId: bksId,
      lastRunStatus: "running",
      lastRunError: undefined,
      lastTrigger: trigger,
    });

    let prompt = automation.prompt;
    if (options?.eventContext) {
      prompt += `\n\n## Triggering event\n\nThis run was triggered by ${trigger === "event" ? `an internal event (${automation.eventKey})` : "a webhook"}. Event payload:\n\n\`\`\`\n${options.eventContext.slice(0, 10_000)}\n\`\`\``;
    }

    // Tie the session to its Plain thread (if the event carries one) so it
    // can be auto-archived when the ticket is done, and use the ticket's
    // title as the session title
    let plainThreadId: string | undefined;
    let eventTitle: string | undefined;
    if (options?.eventContext) {
      try {
        const parsed = JSON.parse(options.eventContext);
        if (typeof parsed.threadId === "string") plainThreadId = parsed.threadId;
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          eventTitle = parsed.title.trim().slice(0, 100);
        }
      } catch {}
    }

    const persistSession = (claudeSessionId: string) => {
      const data: BackstageSessionFile = {
        id: bksId,
        claudeSessionId,
        branch,
        worktreeDir: cwd,
        createdBy: `${automation.name} (automation)`,
        createdAt: startedAt.toISOString(),
        lastActivity: new Date().toISOString(),
        title: eventTitle || `${automation.name} — ${stamp}`,
        mode: automation.mode,
        automation: automation.name,
        plainThreadId,
      };
      writeFileSync(`${SESSIONS_DIR}/${bksId}.json`, JSON.stringify(data, null, 2));
    };

    console.log(`[automations] Running "${automation.name}" → ${bksId}`);

    let claudeSessionId = "";
    let errorMsg = "";
    for await (const event of runClaude({
      prompt,
      cwd,
      mode: automation.mode,
      mcpServers: automation.mcpServers,
      deniedTools: AUTOMATION_DENIED_TOOLS,
      journal: { bksSessionId: bksId, kind: "automation" },
    })) {
      if (event.type === "init") {
        claudeSessionId = event.sessionId || "";
        persistSession(claudeSessionId);
        onSessionCreated?.(bksId);
      }
      if (event.type === "done") {
        claudeSessionId = event.sessionId || claudeSessionId;
      }
      if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }

    persistSession(claudeSessionId);

    const fresh = getAutomation(automation.id);
    if (fresh) {
      saveAutomation({
        ...fresh,
        lastRunAt: startedAt.toISOString(),
        lastRunSessionId: bksId,
        lastRunStatus: errorMsg ? "error" : "ok",
        lastRunError: errorMsg || undefined,
      });
    }
    console.log(
      `[automations] "${automation.name}" finished ${errorMsg ? `with error: ${errorMsg}` : "ok"}`
    );
  } catch (e: any) {
    console.error(`[automations] "${automation.name}" failed:`, e);
    const fresh = getAutomation(automation.id);
    if (fresh) {
      saveAutomation({
        ...fresh,
        lastRunAt: startedAt.toISOString(),
        lastRunSessionId: bksId,
        lastRunStatus: "error",
        lastRunError: e.message || String(e),
      });
    }
  } finally {
    const left = (runningCounts.get(automation.id) || 1) - 1;
    if (left <= 0) runningCounts.delete(automation.id);
    else runningCounts.set(automation.id, left);
  }
}

// ── Internal event bus ───────────────────────────────────────
// Agents (Plain/Slack/Linear) publish events; automations subscribe
// via their eventKey. Each event gets its own run (may overlap).

let eventSessionCallback: ((sessionId: string) => void) | undefined;

export function setEventSessionCallback(cb: (sessionId: string) => void): void {
  eventSessionCallback = cb;
}

export function fireAutomationsForEvent(eventKey: string, payload: string): number {
  let fired = 0;
  for (const automation of listAutomations()) {
    if (!automation.enabled || automation.eventKey !== eventKey) continue;
    console.log(`[automations] Event ${eventKey} → "${automation.name}"`);
    void runAutomation(automation, eventSessionCallback, {
      trigger: "event",
      eventContext: payload,
    });
    fired++;
  }
  return fired;
}

// ── Scheduler ────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredMinute = "";

export function startScheduler(onSessionCreated?: (sessionId: string) => void): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === lastFiredMinute) return;
    lastFiredMinute = minuteKey;

    for (const automation of listAutomations()) {
      if (!automation.enabled || !automation.schedule) continue;
      if (cronMatches(automation.schedule, now)) {
        // Fire and forget — runner guards against overlap per automation
        void runAutomation(automation, onSessionCreated, { trigger: "cron" });
      }
    }
  }, 20_000);

  console.log("[automations] Scheduler started (20s tick, UTC cron)");
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

// ── Webhook trigger ──────────────────────────────────────────
// POST /automations/<id>/<secret> on the public webhook server (3848,
// proxied by Caddy). The secret in the path is the only auth, so it's
// long-random and rotatable by editing the automation file.

export function getWebhookRoutes(
  onSessionCreated?: (sessionId: string) => void
): Map<string, (req: Request, url: URL) => Promise<Response>> {
  const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

  routes.set("POST /automations/*", async (req, url) => {
    const m = url.pathname.match(/^\/automations\/([^/]+)\/([^/]+)$/);
    if (!m) return Response.json({ error: "Bad path" }, { status: 400 });

    const automation = getAutomation(m[1]);
    // Same response for unknown id and bad secret — don't leak which ids exist
    if (!automation || !automation.webhookSecret || automation.webhookSecret !== m[2]) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!automation.enabled) {
      return Response.json({ ok: false, skipped: "disabled" });
    }
    if (isAutomationRunning(automation.id)) {
      return Response.json({ ok: false, skipped: "already running" });
    }

    let payload = "";
    try {
      payload = (await req.text()).slice(0, 10_000);
    } catch {}

    console.log(`[automations] Webhook trigger: "${automation.name}"`);
    void runAutomation(automation, onSessionCreated, {
      trigger: "webhook",
      eventContext: payload || "(empty body)",
    });

    return Response.json({ ok: true });
  });

  return routes;
}
