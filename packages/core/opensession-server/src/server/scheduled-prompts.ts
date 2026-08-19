/**
 * Scheduled prompts: "send this to this session at 5pm". A tiny store +
 * due-taker; opensession.ts's boot loop polls takeDuePrompts() every 30s and
 * delivers each one through the SessionControl registry (steer if the session
 * is mid-run, queue behind an external run, or start a fresh turn) — exactly
 * as if the user had typed it at that moment.
 *
 * Distinct from automations' runOnceAt (which creates a NEW session per run):
 * these target an EXISTING session and ride its normal prompt path.
 */
import { randomUUIDv7 } from "bun";
import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

const STORE_PATH = stateDir("scheduled-prompts.json");

export interface ScheduledPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  /** Display name credited when the prompt fires. */
  user: string;
  /** ISO instant to deliver at. */
  at: string;
  createdAt: string;
}

interface Store {
  prompts: ScheduledPrompt[];
}

function readStore(): Store {
  try {
    if (existsSync(STORE_PATH)) {
      const s = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
      if (Array.isArray(s.prompts)) return s;
    }
  } catch {}
  return { prompts: [] };
}

export function listScheduledPrompts(sessionId?: string): ScheduledPrompt[] {
  const all = readStore().prompts;
  return (sessionId ? all.filter((p) => p.sessionId === sessionId) : all).sort(
    (a, b) => a.at.localeCompare(b.at),
  );
}

export function createScheduledPrompt(input: {
  sessionId: string;
  prompt: string;
  at: string;
  user: string;
}): ScheduledPrompt | { error: string } {
  if (!input.sessionId?.trim()) return { error: "sessionId required" };
  if (!input.prompt?.trim()) return { error: "Prompt is required" };
  const t = Date.parse(input.at || "");
  if (Number.isNaN(t)) return { error: `Invalid time: "${input.at}"` };
  if (t < Date.now() - 60_000) return { error: "That time is in the past" };
  const p: ScheduledPrompt = {
    id: `sched-${randomUUIDv7()}`,
    sessionId: input.sessionId.trim(),
    prompt: input.prompt.trim(),
    user: input.user?.trim() || "Anonymous",
    at: new Date(t).toISOString(),
    createdAt: new Date().toISOString(),
  };
  const store = readStore();
  store.prompts.push(p);
  writeJsonAtomic(STORE_PATH, store);
  return p;
}

export function deleteScheduledPrompt(id: string): boolean {
  const store = readStore();
  const before = store.prompts.length;
  store.prompts = store.prompts.filter((p) => p.id !== id);
  if (store.prompts.length === before) return false;
  writeJsonAtomic(STORE_PATH, store);
  return true;
}

/**
 * Remove and return everything due at `now`. Persisted BEFORE returning, so a
 * crash mid-delivery can't double-fire on the next tick (matches the
 * consumed-before-firing pattern in automations' runOnceAt).
 */
export function takeDuePrompts(now = Date.now()): ScheduledPrompt[] {
  const store = readStore();
  const due = store.prompts.filter((p) => Date.parse(p.at) <= now);
  if (due.length === 0) return [];
  store.prompts = store.prompts.filter((p) => Date.parse(p.at) > now);
  writeJsonAtomic(STORE_PATH, store);
  return due;
}
