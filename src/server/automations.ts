/**
 * Automations: cron-scheduled Michael sessions, Devin-style.
 * Records live in ~/.backstage-automations/<id>.json; each run creates a
 * normal backstage session so it shows up in the sessions list and UI.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { parseCron, cronMatches, nextRun } from "./cron";
import { STRIPE_CONFIRM_TOOLS } from "./claude-runner";
import { runAgent } from "./agent-runner";
import { providerFor, resolveModel, DEFAULT_FALLBACK_MODEL } from "./models";
import { createWorktree, listWorktrees } from "./worktree";
import type { BackstageSessionFile } from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const AUTOMATIONS_DIR = `${HOME}/.backstage-automations`;
const SESSIONS_DIR = `${HOME}/.backstage-sessions`;
const TELLA_FUSION = `${HOME}/projects/tella-fusion`;

/**
 * Config for an automation that is driven by polling a Grafana Loki failure
 * signal: a generic poller (src/agents/grafana-poller) re-runs `lokiQuery` on a
 * timer, collapses the result series to one row per distinct `dedupLabel` value,
 * and fires one run of this automation per fresh failure (deduped over
 * `dedupDays`). The matched Loki labels are handed to the run as the triggering
 * event. Adding a new failure-signal investigator is therefore data — create an
 * automation with this config; no code change or restart.
 */
export interface GrafanaPollConfig {
  /** LogQL instant query. The literal token `$LOOKBACK` is replaced with `lookback`. */
  lokiQuery: string;
  /** Label whose distinct values define one failure (e.g. "story_id", "streaming_upload_id"). */
  dedupLabel: string;
  /** Slack channel id for the control card + investigation thread. */
  slackChannel: string;
  /** Human label for the card, e.g. "export failure" / "upload processing failure". */
  cardTitle: string;
  /** Range vector for the query, default "20m". */
  lookback?: string;
  /** Poll cadence in minutes, default 15. */
  pollMinutes?: number;
  /** Dedup window in days, default 7. */
  dedupDays?: number;
  /** Only fire for this namespace label, default "prod". Empty string disables the filter. */
  namespace?: string;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string; // 5-field cron, UTC; "" = webhook/manual only
  /**
   * One-off scheduled run: ISO8601 instant. When set, the scheduler fires this
   * automation once at/after this time and then deletes it (auto-cleanup).
   * Mutually exclusive with `schedule` (recurring cron) — setting it forces
   * `schedule` to "". Used for reminders, "run this again later", and any
   * one-time scheduled prompt (see schedule_once in admin-tools.ts).
   */
  runOnceAt?: string;
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
  /**
   * If set, this automation is poll-triggered off a Grafana Loki signal by the
   * generic grafana-poller agent (one run per fresh failure). See GrafanaPollConfig.
   */
  grafanaPoll?: GrafanaPollConfig;
  /**
   * Model id for new runs (claude-* or gpt-*; see models.ts). Omitted =
   * default model. Codex models enforce tool denials as per-server
   * disabled_tools instead of canUseTool — see codex-runner.ts.
   */
  model?: string;
  /**
   * Model to switch to when the primary's whole account pool is exhausted.
   * Unset = the global default fallback (gpt-5.5); "none" disables fallback.
   */
  fallbackModel?: string;
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
        nextRunAt: !a.enabled
          ? null
          : a.runOnceAt
            ? a.runOnceAt
            : a.schedule
              ? nextRun(a.schedule)?.toISOString() || null
              : null,
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

function sanitizeGrafanaPoll(cfg?: unknown): GrafanaPollConfig | { error: string } | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== "object") return { error: "grafanaPoll must be an object" };
  const c = cfg as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const lokiQuery = str(c.lokiQuery);
  const dedupLabel = str(c.dedupLabel);
  const slackChannel = str(c.slackChannel);
  const cardTitle = str(c.cardTitle);
  if (!lokiQuery || !dedupLabel || !slackChannel || !cardTitle) {
    return { error: "grafanaPoll requires lokiQuery, dedupLabel, slackChannel, and cardTitle" };
  }
  const out: GrafanaPollConfig = { lokiQuery, dedupLabel, slackChannel, cardTitle };
  if (str(c.lookback)) out.lookback = str(c.lookback);
  if (typeof c.namespace === "string") out.namespace = c.namespace.trim(); // "" = no filter
  if (typeof c.pollMinutes === "number" && c.pollMinutes > 0) out.pollMinutes = c.pollMinutes;
  if (typeof c.dedupDays === "number" && c.dedupDays > 0) out.dedupDays = c.dedupDays;
  return out;
}

/** Validate + normalize a one-off ISO8601 instant. "" / nullish → undefined
 *  (no one-off). Past times are allowed (they fire on the next tick). */
function sanitizeRunOnceAt(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "runOnceAt must be an ISO8601 string" };
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) return { error: `Invalid date/time: "${v}"` };
  return new Date(t).toISOString();
}

function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function sanitizeModel(model?: unknown, allowNone = false): string | { error: string } | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  if (allowNone && model.trim().toLowerCase() === "none") return "none";
  const resolved = resolveModel(model);
  if (!resolved) return { error: `Unknown model "${model}"` };
  return resolved.id;
}

export function createAutomation(input: {
  name: string;
  prompt: string;
  schedule: string;
  /** One-off ISO8601 instant; when set, `schedule` is ignored (forced to ""). */
  runOnceAt?: string;
  mode: "ask" | "code";
  createdBy: string;
  eventKey?: string;
  mcpServers?: string[];
  model?: string;
  fallbackModel?: string;
  grafanaPoll?: GrafanaPollConfig;
}): Automation | { error: string } {
  if (!input.name.trim()) return { error: "Name is required" };
  if (!input.prompt.trim()) return { error: "Prompt is required" };
  const runOnceAt = sanitizeRunOnceAt(input.runOnceAt);
  if (runOnceAt && typeof runOnceAt === "object") return runOnceAt;
  // A one-off and a recurring cron are mutually exclusive — the one-off wins.
  const schedule = runOnceAt ? "" : (input.schedule || "").trim();
  if (schedule && !parseCron(schedule)) {
    return { error: `Invalid cron expression: "${schedule}"` };
  }
  const model = sanitizeModel(input.model);
  if (model && typeof model === "object") return model;
  const fallbackModel = sanitizeModel(input.fallbackModel, true);
  if (fallbackModel && typeof fallbackModel === "object") return fallbackModel;
  const grafanaPoll = sanitizeGrafanaPoll(input.grafanaPoll);
  if (grafanaPoll && "error" in grafanaPoll) return grafanaPoll;

  const a: Automation = {
    id: `auto-${randomUUIDv7()}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    schedule,
    runOnceAt,
    mode: input.mode === "code" ? "code" : "ask",
    enabled: true,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    webhookSecret: generateSecret(),
    eventKey: (input.eventKey || "").trim() || undefined,
    mcpServers: sanitizeMcpList(input.mcpServers),
    model,
    fallbackModel,
    grafanaPoll,
  };
  saveAutomation(a);
  return a;
}

export function updateAutomation(
  id: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "runOnceAt" | "mode" | "enabled" | "eventKey" | "mcpServers" | "model" | "fallbackModel" | "grafanaPoll">>
): Automation | { error: string } {
  const a = getAutomation(id);
  if (!a) return { error: "Automation not found" };
  if (patch.schedule !== undefined && patch.schedule.trim() && !parseCron(patch.schedule)) {
    return { error: `Invalid cron expression: "${patch.schedule}"` };
  }
  const next = { ...a, ...patch };
  if ("runOnceAt" in patch) {
    const runOnceAt = sanitizeRunOnceAt(patch.runOnceAt);
    if (runOnceAt && typeof runOnceAt === "object") return runOnceAt;
    next.runOnceAt = runOnceAt;
    if (runOnceAt) next.schedule = ""; // one-off and cron are mutually exclusive
  }
  if ("mcpServers" in patch) next.mcpServers = sanitizeMcpList(patch.mcpServers);
  if ("grafanaPoll" in patch) {
    const grafanaPoll = sanitizeGrafanaPoll(patch.grafanaPoll);
    if (grafanaPoll && "error" in grafanaPoll) return grafanaPoll;
    next.grafanaPoll = grafanaPoll;
  }
  if ("model" in patch) {
    const model = sanitizeModel(patch.model);
    if (model && typeof model === "object") return model;
    next.model = model;
  }
  if ("fallbackModel" in patch) {
    const fallbackModel = sanitizeModel(patch.fallbackModel, true);
    if (fallbackModel && typeof fallbackModel === "object") return fallbackModel;
    next.fallbackModel = fallbackModel;
  }
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
// WorkOS lookups (get_*/list_*) are fine for investigation, but its MCP also
// exposes destructive identity tools — creating/deleting users and orgs,
// revoking sessions, password resets, and especially impersonation URLs (login
// as the customer). Untrusted ticket text must never reach those, so deny the
// write/destructive subset at the tool layer and keep the read tools.
const WORKOS_WRITE_DENIAL =
  "This tool isn't available in automation runs — they get read-only WorkOS " +
  "access for investigation. Use get_*/list_* to look up the user/org; if a " +
  "change is needed, recommend it in the note for a human to do.";
const AUTOMATION_DENIED_TOOLS: Record<string, string> = {
  // Plain: read + internal note only, never customer-facing or state-changing
  mcp__plain__reply_to_thread: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_done: PLAIN_WRITE_DENIAL,
  mcp__plain__mark_thread_todo: PLAIN_WRITE_DENIAL,
  mcp__plain__snooze_thread: PLAIN_WRITE_DENIAL,
  // WorkOS: read-only — no identity mutation or impersonation from a run
  mcp__workos__create_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__create_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__create_user: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__delete_user: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization: WORKOS_WRITE_DENIAL,
  mcp__workos__update_organization_membership: WORKOS_WRITE_DENIAL,
  mcp__workos__update_user: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__revoke_session: WORKOS_WRITE_DENIAL,
  mcp__workos__send_invitation: WORKOS_WRITE_DENIAL,
  mcp__workos__send_password_reset_email: WORKOS_WRITE_DENIAL,
  mcp__workos__send_verification_email: WORKOS_WRITE_DENIAL,
  mcp__workos__get_impersonation_url: WORKOS_WRITE_DENIAL,
};

/** Tool-permission denials applied to every automation run (and to interactive
 *  resumes of automation-owned sessions). Read-only toward customers/identity. */
export function automationDeniedTools(): Record<string, string> {
  return AUTOMATION_DENIED_TOOLS;
}

/** MCP allowlist for an automation, resolved by its display name (as stored on
 *  a session's `automation` field). Returns undefined if not found. */
export function automationMcpServersByName(name: string): string[] | undefined {
  return listAutomations().find((a) => a.name === name)?.mcpServers;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
}

export function isAutomationRunning(id: string): boolean {
  return (runningCounts.get(id) || 0) > 0;
}

export async function runAutomation(
  automation: Automation,
  onSessionCreated?: (sessionId: string) => void,
  options?: {
    trigger?: "cron" | "webhook" | "manual" | "event";
    eventContext?: string;
    /**
     * Pre-generated backstage session id. Lets a caller post UI/Slack controls
     * that reference the session (e.g. an Open-in-Backstage link and a Stop
     * button) before the run starts, instead of waiting for onSessionCreated.
     */
    bksSessionId?: string;
  }
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
  const bksId = options?.bksSessionId || `bks-${randomUUIDv7()}`;

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

    // The effective model/provider can change mid-run (usage-limit fallback),
    // so track them from the runner's init/done events for persistence.
    let effectiveModel = automation.model;
    let effectiveProvider = providerFor(automation.model);
    const persistSession = (engineSessionId: string) => {
      const isCodex = effectiveProvider === "codex";
      const data: BackstageSessionFile = {
        id: bksId,
        claudeSessionId: isCodex ? "" : engineSessionId,
        ...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
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

    console.log(
      `[automations] Running "${automation.name}" → ${bksId}${automation.model ? ` (${automation.model})` : ""}`
    );

    let engineSessionId = "";
    let errorMsg = "";
    for await (const event of runAgent({
      prompt,
      cwd,
      mode: automation.mode,
      model: automation.model,
      mcpServers: automation.mcpServers,
      deniedTools: AUTOMATION_DENIED_TOOLS,
      // No onAskUser here, so confirm tools deny with "propose it for a human"
      // (on codex models they're disabled outright — see codex-runner.ts)
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: true, // automation runs get short-lived instance-role read creds
      fallbackModel:
        automation.fallbackModel === "none"
          ? undefined
          : automation.fallbackModel || DEFAULT_FALLBACK_MODEL,
      journal: { bksSessionId: bksId, kind: "automation" },
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || "";
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
        persistSession(engineSessionId);
        onSessionCreated?.(bksId);
      }
      if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      }
      if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }

    persistSession(engineSessionId);

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
      if (!automation.enabled) continue;

      // One-off runs (reminders / "do this again later"): fire once at/after the
      // target instant, then delete. We persist a "consumed" copy (runOnceAt
      // cleared, disabled) BEFORE firing so a long-running or crashed run can
      // never double-fire on a later tick; the file is deleted once it settles.
      if (automation.runOnceAt) {
        if (Date.parse(automation.runOnceAt) <= now.getTime()) {
          saveAutomation({ ...automation, runOnceAt: undefined, enabled: false });
          void runAutomation({ ...automation, runOnceAt: undefined, enabled: false }, onSessionCreated, {
            trigger: "cron",
          }).finally(() => deleteAutomation(automation.id));
        }
        continue;
      }

      if (!automation.schedule) continue;
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
