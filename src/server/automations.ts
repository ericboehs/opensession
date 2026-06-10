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
  schedule: string; // 5-field cron, UTC
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
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
        nextRunAt: a.enabled ? nextRun(a.schedule)?.toISOString() || null : null,
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

export function createAutomation(input: {
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  createdBy: string;
}): Automation | { error: string } {
  if (!input.name.trim()) return { error: "Name is required" };
  if (!input.prompt.trim()) return { error: "Prompt is required" };
  if (!parseCron(input.schedule)) return { error: `Invalid cron expression: "${input.schedule}"` };

  const a: Automation = {
    id: `auto-${randomUUIDv7()}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    schedule: input.schedule.trim(),
    mode: input.mode === "code" ? "code" : "ask",
    enabled: true,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
  };
  saveAutomation(a);
  return a;
}

export function updateAutomation(
  id: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "mode" | "enabled">>
): Automation | { error: string } {
  const a = getAutomation(id);
  if (!a) return { error: "Automation not found" };
  if (patch.schedule !== undefined && !parseCron(patch.schedule)) {
    return { error: `Invalid cron expression: "${patch.schedule}"` };
  }
  const next = { ...a, ...patch };
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

const runningNow = new Set<string>();

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
}

export function isAutomationRunning(id: string): boolean {
  return runningNow.has(id);
}

export async function runAutomation(
  automation: Automation,
  onSessionCreated?: (sessionId: string) => void
): Promise<void> {
  if (runningNow.has(automation.id)) {
    console.log(`[automations] "${automation.name}" still running, skipping`);
    return;
  }
  runningNow.add(automation.id);

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
    });

    const persistSession = (claudeSessionId: string) => {
      const data: BackstageSessionFile = {
        id: bksId,
        claudeSessionId,
        branch,
        worktreeDir: cwd,
        createdBy: `${automation.name} (automation)`,
        createdAt: startedAt.toISOString(),
        lastActivity: new Date().toISOString(),
        title: `${automation.name} — ${stamp}`,
        mode: automation.mode,
      };
      writeFileSync(`${SESSIONS_DIR}/${bksId}.json`, JSON.stringify(data, null, 2));
    };

    console.log(`[automations] Running "${automation.name}" → ${bksId}`);

    let claudeSessionId = "";
    let errorMsg = "";
    for await (const event of runClaude({
      prompt: automation.prompt,
      cwd,
      mode: automation.mode,
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
    runningNow.delete(automation.id);
  }
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
      if (cronMatches(automation.schedule, now)) {
        // Fire and forget — runner guards against overlap per automation
        void runAutomation(automation, onSessionCreated);
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
