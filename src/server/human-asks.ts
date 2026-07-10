/**
 * human-asks — the "human in the loop" registry. Lets a Backstage session ask a
 * *teammate* a question over Slack and fold the answer back into the session,
 * the way the AskUserQuestion machinery asks the session's own driver.
 *
 * Two axes (see src/agents/slack/humans-tools.ts for the tool surface):
 *  - mode: "block" holds the agent's turn open until the teammate replies (bounded
 *    by BLOCK_TIMEOUT_MS, then it degrades to async so a late reply still lands);
 *    "async" returns immediately and the reply is steered into the session later.
 *  - deliver: "now" pings immediately; "when_done" / "on_pr" hold the ping until the
 *    session next goes idle / has opened a PR; { atIso } fires at a scheduled time.
 *
 * This module owns the ask *data* (the map + disk persistence + reply matching +
 * audit). The two things only the main backstage process can do — steer an answer
 * into a live session and broadcast — it reaches through the session-control
 * registry (tryGetSessionControl), exactly like the opensession-sessions MCP does.
 * The Slack transport (DM send + option cards) is imported directly from the
 * Slack agent's slack-api helpers; nothing there imports back into the server, so
 * there's no import cycle.
 *
 * Wired into interactive runs only (Slack + Backstage sessions), never automation
 * runs — same privilege boundary as opensession-sessions/opensession-admin: untrusted
 * ticket text must not be able to DM the team as Michael.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { envAlias } from "./rename-compat";
import { audit } from "./audit";
import { tryGetSessionControl } from "./session-control";
import {
  openDirectMessage,
  postSlackBlocks,
  sendSlackMessage,
} from "../agents/slack/slack-api";
import { personaName, productName } from "./config";

const HOME = process.env.HOME || "/home/ubuntu";
const STORE = `${OPENSESSION_CHATS_DIR}/human-asks.json`;
const UI_BASE =
  // Default stays on /backstage until the operator flips OPENSESSION_UI_BASE in
  // the restart window (the alias path keeps old links working forever).
  envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE") ||
  "https://michael.taila5d766.ts.net/backstage";

/** How long a "block" ask holds the agent's turn before degrading to async. */
const BLOCK_TIMEOUT_MS = 20 * 60 * 1000;
/** Terminal asks older than this are pruned from the store on load. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type HumanAskState =
  | "scheduled" // registered, not yet delivered (deferred trigger pending)
  | "delivered" // DM sent, awaiting a reply
  | "answered"
  | "timeout"
  | "cancelled";

/** When the teammate is actually pinged. A string atIso means "at that instant". */
export type DeliverWhen = "now" | "when_done" | "on_pr" | { atIso: string };

export interface HumanAsk {
  id: string;
  /** Backstage session that raised the ask (answers route back here). */
  sessionId: string;
  /** Display name of whoever drove the session when it asked. */
  createdBy: string;
  person: { slackId: string; name: string };
  question: string;
  /** Extra background included in the DM (a file, a screen, a decision, …). */
  context?: string;
  /** Quick-pick option labels → buttons; absent → free-text reply. */
  options?: string[];
  mode: "block" | "async";
  deliver: DeliverWhen;
  state: HumanAskState;
  /** Set once delivered: the DM channel and the question message's ts (thread root). */
  slack?: { channel: string; rootTs: string };
  answer?: string;
  answeredBy?: string;
  createdAt: string;
  deliveredAt?: string;
  answeredAt?: string;
}

interface Stored {
  asks: HumanAsk[];
}

const g = globalThis as any;
/** All asks, by id. Persisted to disk. */
const asks: Map<string, HumanAsk> = (g.__humanAsks ??= new Map());
/** Block-mode resolvers, in-memory only — their presence marks an ask as a live
 *  blocking wait (vs. an async ask, or a block that timed out / lost its process). */
const resolvers: Map<string, (answer: string | null) => void> = (g.__humanAskResolvers ??=
  new Map());
/** Armed timers for { atIso } deliveries, in-memory only (re-armed on boot). */
const atTimers: Map<string, ReturnType<typeof setTimeout>> = (g.__humanAskTimers ??= new Map());

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persist(): void {
  try {
    const data: Stored = { asks: [...asks.values()] };
    writeJsonAtomic(STORE, data, false);
  } catch (e) {
    console.error("[human-asks] persist failed:", e);
  }
}

function isTerminal(a: HumanAsk): boolean {
  return a.state === "answered" || a.state === "cancelled" || a.state === "timeout";
}

/**
 * Load persisted asks on boot. Prune old terminal asks. Block asks that were
 * mid-flight at the last exit lost their in-process resolver, so degrade them to
 * async — a late teammate reply then still steers into the (resumed) session
 * instead of vanishing. Re-arm timers for scheduled { atIso } deliveries.
 */
export function initHumanAsks(): void {
  if (existsSync(STORE)) {
    try {
      const data: Stored = JSON.parse(readFileSync(STORE, "utf-8"));
      const cutoff = Date.now() - TERMINAL_RETENTION_MS;
      for (const a of data.asks || []) {
        if (isTerminal(a)) {
          const t = new Date(a.answeredAt || a.createdAt).getTime();
          if (t && t < cutoff) continue; // prune
        }
        // A delivered block ask can't resume its held turn after a restart.
        if (a.state === "delivered" && a.mode === "block") a.mode = "async";
        asks.set(a.id, a);
      }
    } catch (e) {
      console.error("[human-asks] load failed:", e);
    }
  }
  // Re-arm scheduled time deliveries.
  for (const a of asks.values()) {
    if (a.state === "scheduled" && typeof a.deliver === "object" && a.deliver.atIso) {
      armTimer(a);
    }
  }
}

function armTimer(a: HumanAsk): void {
  if (typeof a.deliver !== "object") return;
  if (atTimers.has(a.id)) return;
  const fireAt = new Date(a.deliver.atIso).getTime();
  const delay = Math.max(0, fireAt - Date.now());
  // setTimeout caps at ~24.8 days; for anything further, re-check hourly.
  const MAX = 6 * 60 * 60 * 1000;
  const timer = setTimeout(
    () => {
      atTimers.delete(a.id);
      const cur = asks.get(a.id);
      if (!cur || cur.state !== "scheduled") return;
      if (typeof cur.deliver === "object" && new Date(cur.deliver.atIso).getTime() > Date.now()) {
        armTimer(cur); // not due yet (long-delay re-check) — re-arm
        return;
      }
      void deliverAsk(a.id).catch((e) => console.error("[human-asks] timed delivery failed:", e));
    },
    Math.min(delay, MAX)
  );
  atTimers.set(a.id, timer);
}

// ---------------------------------------------------------------------------
// Creating + delivering
// ---------------------------------------------------------------------------

export interface CreateAskInput {
  sessionId: string;
  createdBy: string;
  person: { slackId: string; name: string };
  question: string;
  context?: string;
  options?: string[];
  mode: "block" | "async";
  deliver: DeliverWhen;
}

/** Register an ask and trigger its delivery if it's due now / arm its timer. */
export function registerAsk(input: CreateAskInput): HumanAsk {
  const ask: HumanAsk = {
    id: `ask-${crypto.randomUUID()}`,
    sessionId: input.sessionId,
    createdBy: input.createdBy,
    person: input.person,
    question: input.question,
    context: input.context,
    options: input.options?.length ? input.options : undefined,
    mode: input.mode,
    deliver: input.deliver,
    state: "scheduled",
    createdAt: new Date().toISOString(),
  };
  asks.set(ask.id, ask);
  persist();
  audit({
    context: "human_ask",
    action: "created",
    ask_id: ask.id,
    session_id: ask.sessionId,
    created_by: ask.createdBy,
    person: ask.person.name,
    mode: ask.mode,
    deliver: typeof ask.deliver === "object" ? `at:${ask.deliver.atIso}` : ask.deliver,
  });

  if (ask.deliver === "now") {
    void deliverAsk(ask.id).catch((e) => console.error("[human-asks] deliver failed:", e));
  } else if (typeof ask.deliver === "object") {
    armTimer(ask);
  } // when_done / on_pr stay scheduled until onSessionIdle fires them.

  return ask;
}

const firstName = (full: string) => full.split(" ")[0] || full;

function deliveryBlocks(a: HumanAsk): { fallback: string; blocks: any[] } {
  const link = `${UI_BASE}/session/${a.sessionId}`;
  const intro =
    `Hey ${firstName(a.person.name)} — it's *${personaName()}* :robot_face:. ` +
    `${a.createdBy} has me working on something and needs your input:`;
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: intro } },
    { type: "section", text: { type: "mrkdwn", text: `> ${a.question.replace(/\n/g, "\n> ")}` } },
  ];
  if (a.context) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: a.context.slice(0, 2900) } });
  }
  if (a.options?.length) {
    const buttons: any[] = a.options.slice(0, 9).map((label, i) => ({
      type: "button",
      text: { type: "plain_text", text: label.slice(0, 75), emoji: true },
      action_id: `humanask-${a.id}-opt-${i}`,
      value: label,
    }));
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: "Other…", emoji: true },
      action_id: `humanask-${a.id}-other`,
      style: "primary",
    });
    blocks.push({ type: "actions", elements: buttons });
  } else {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "_Reply here and I'll bring it straight back into the session._" },
      ],
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${link}|Open the session in ${productName()}>` }],
  });
  return { fallback: `${personaName()} needs your input: ${a.question}`, blocks };
}

/** Open a DM with the teammate and post the question. Marks the ask delivered. */
export async function deliverAsk(id: string): Promise<boolean> {
  const a = asks.get(id);
  if (!a || a.state !== "scheduled") return false;
  const channel = await openDirectMessage(a.person.slackId);
  if (!channel) {
    console.error(`[human-asks] couldn't open DM with ${a.person.name} (${a.person.slackId})`);
    return false;
  }
  const { fallback, blocks } = deliveryBlocks(a);
  const res = await postSlackBlocks(channel, fallback, blocks);
  if (!res?.ok || !res.ts) {
    console.error(`[human-asks] DM post failed for ${id}:`, res?.error);
    return false;
  }
  a.state = "delivered";
  a.slack = { channel, rootTs: res.ts };
  a.deliveredAt = new Date().toISOString();
  asks.set(id, a);
  persist();
  audit({
    context: "human_ask",
    action: "delivered",
    ask_id: id,
    session_id: a.sessionId,
    person: a.person.name,
    channel,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Blocking await
// ---------------------------------------------------------------------------

/**
 * For a "block" ask: register a resolver and return a promise that settles when
 * the teammate replies (the answer), or after BLOCK_TIMEOUT_MS (null). On
 * timeout the ask degrades to async so a later reply still steers into the
 * session rather than being dropped.
 */
export function awaitBlockingAnswer(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolvers.delete(id);
      const a = asks.get(id);
      if (a && a.state === "delivered") {
        a.mode = "async"; // a late reply now routes back via deliverToSession
        persist();
      }
      resolve(null);
    }, BLOCK_TIMEOUT_MS);
    resolvers.set(id, (answer) => {
      clearTimeout(timer);
      resolvers.delete(id);
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Resolving (a teammate answered)
// ---------------------------------------------------------------------------

function shortQ(a: HumanAsk): string {
  return a.question.length > 80 ? `${a.question.slice(0, 80)}…` : a.question;
}

/** Mark an ask answered, audit it, and route the answer (block resolver if the
 *  wait is still live in this process, otherwise steer it into the session). */
function resolveAsk(a: HumanAsk, answer: string, answeredBy: string): void {
  a.state = "answered";
  a.answer = answer;
  a.answeredBy = answeredBy;
  a.answeredAt = new Date().toISOString();
  asks.set(a.id, a);
  persist();
  audit({
    context: "human_ask",
    action: "answered",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    answered_by: answeredBy,
    answer_len: answer.length,
  });

  const resolver = resolvers.get(a.id);
  if (resolver) {
    resolver(answer); // live block — the awaiting tool call returns the answer
    return;
  }
  // Async (or a block whose wait already timed out / lost its process): steer
  // the answer into the session like a human typing in the web UI.
  const ctrl = tryGetSessionControl();
  if (!ctrl) {
    console.error(`[human-asks] no session control to deliver answer for ${a.id}`);
    return;
  }
  // Unicode emoji (the Backstage markdown renderer doesn't expand :shortcodes:)
  // and a structured header the web UI keys on to render this as a distinct
  // "human reply" bubble rather than one of the session driver's own messages.
  const msg = `💬 **${a.person.name}** answered (via Slack) — "${shortQ(a)}":\n\n${answer}`;
  void ctrl
    .deliverToSession(a.sessionId, msg, a.person.name)
    .catch((e) => console.error(`[human-asks] deliver answer to ${a.sessionId} failed:`, e));
}

/**
 * Try to match an inbound Slack message to an outstanding ask. Accepts a reply
 * ONLY from the exact teammate the ask was sent to, in that ask's DM channel.
 * Prefers a reply threaded under the question; falls back to the most recent
 * delivered ask in the channel (teammates often reply without threading in a DM).
 * Returns the matched ask (now answered) or null. This is the one place that
 * deliberately accepts a message from someone other than the trusted user.
 */
export function matchReply(input: {
  channel: string;
  user: string;
  threadTs?: string;
  text: string;
}): HumanAsk | null {
  const text = (input.text || "").trim();
  if (!text) return null;
  const candidates = [...asks.values()].filter(
    (a) =>
      a.state === "delivered" &&
      a.slack?.channel === input.channel &&
      a.person.slackId === input.user
  );
  if (!candidates.length) return null;

  let match =
    (input.threadTs && candidates.find((a) => a.slack!.rootTs === input.threadTs)) || undefined;
  if (!match) {
    // Newest delivered ask in this DM wins for an un-threaded reply.
    match = candidates.sort(
      (x, y) => new Date(y.deliveredAt!).getTime() - new Date(x.deliveredAt!).getTime()
    )[0];
  }
  if (!match) return null;

  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: match.id,
    session_id: match.sessionId,
    person: match.person.name,
    from_user: input.user,
    threaded: !!(input.threadTs && match.slack!.rootTs === input.threadTs),
  });
  resolveAsk(match, text, match.person.name);
  return match;
}

/** Resolve a delivered ask with an answer given in the session UI (the question
 *  card humans-tools offers alongside the Slack DM for block asks). Fires the
 *  live block resolver — the awaiting tool call returns this answer — and posts
 *  a follow-up in the DM thread so the asked teammate isn't left answering a
 *  moot question. Returns true if the ask was still outstanding. */
export function resolveAskFromUI(askId: string, answer: string, answeredBy: string): boolean {
  const a = asks.get(askId);
  if (!a || a.state !== "delivered") return false;
  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    via: "ui",
    answered_by: answeredBy,
  });
  resolveAsk(a, answer, answeredBy);
  if (a.slack) {
    void sendSlackMessage(
      a.slack.channel,
      `:white_check_mark: _${answeredBy} answered this in ${productName()} — all set: "${answer.slice(0, 280)}"_`,
      a.slack.rootTs
    ).catch(() => {});
  }
  return true;
}

/** Resolve an option-button / modal answer by ask id (from the Slack interactivity
 *  endpoint). Returns true if it was an outstanding ask. */
export function resolveByOption(askId: string, label: string): boolean {
  const a = asks.get(askId);
  if (!a || a.state !== "delivered") return false;
  audit({
    context: "human_ask",
    action: "reply_accepted",
    ask_id: a.id,
    session_id: a.sessionId,
    person: a.person.name,
    via: "button",
  });
  resolveAsk(a, label, a.person.name);
  return true;
}

/** True if this ask is still awaiting a reply (used to gate the modal "Other…"). */
export function isAwaiting(askId: string): boolean {
  return asks.get(askId)?.state === "delivered";
}

// ---------------------------------------------------------------------------
// Deferred-trigger firing
// ---------------------------------------------------------------------------

/**
 * Called when a session finishes a run with nothing queued (it just went idle).
 * Fires any scheduled "when_done" asks for it, plus "on_pr" asks once the
 * session has a PR. Idempotent — a delivered ask won't re-fire.
 */
export function onSessionIdle(sessionId: string): void {
  // A block ask can only hold a turn while its run is alive — the session
  // going idle means the awaiting tool call is gone (interrupt, cancel, or
  // crash). Degrade to async so a late reply steers into the session as a new
  // message instead of resolving into the dead tool call and vanishing
  // (2026-07-10: an SSO ask stayed block+delivered after an interrupt; a
  // later Slack reply would have been silently eaten by the orphaned
  // resolver).
  for (const a of asks.values()) {
    if (a.sessionId !== sessionId || a.state !== "delivered" || a.mode !== "block") continue;
    const resolver = resolvers.get(a.id);
    if (resolver) resolver(null); // settles the orphaned await; its tool is dead
    a.mode = "async";
    asks.set(a.id, a);
    persist();
    audit({
      context: "human_ask",
      action: "degraded_to_async",
      ask_id: a.id,
      session_id: sessionId,
      reason: "session_idle_with_block_pending",
    });
  }

  const pending = [...asks.values()].filter(
    (a) => a.sessionId === sessionId && a.state === "scheduled"
  );
  if (!pending.length) return;
  let hasPr = false;
  const ctrl = tryGetSessionControl();
  if (ctrl) hasPr = !!ctrl.getSession(sessionId)?.prUrl;
  for (const a of pending) {
    if (a.deliver === "when_done" || (a.deliver === "on_pr" && hasPr)) {
      void deliverAsk(a.id).catch((e) =>
        console.error(`[human-asks] idle delivery failed for ${a.id}:`, e)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Listing + cancelling (for the MCP)
// ---------------------------------------------------------------------------

export function listAsks(opts?: { sessionId?: string; includeAnswered?: boolean }): HumanAsk[] {
  let out = [...asks.values()];
  if (opts?.sessionId) out = out.filter((a) => a.sessionId === opts.sessionId);
  if (!opts?.includeAnswered) {
    out = out.filter((a) => a.state === "scheduled" || a.state === "delivered");
  }
  return out.sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
}

export function getAsk(id: string): HumanAsk | undefined {
  return asks.get(id);
}

export function cancelAsk(id: string): boolean {
  const a = asks.get(id);
  if (!a || isTerminal(a)) return false;
  a.state = "cancelled";
  asks.set(id, a);
  const timer = atTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    atTimers.delete(id);
  }
  const resolver = resolvers.get(id);
  if (resolver) resolver(null);
  persist();
  audit({ context: "human_ask", action: "cancelled", ask_id: id, session_id: a.sessionId });
  // If it was already delivered, let the teammate know it's moot.
  if (a.slack) {
    void sendSlackMessage(
      a.slack.channel,
      `:heavy_multiplication_x: _Never mind — ${personaName()} no longer needs an answer to that one._`,
      a.slack.rootTs
    ).catch(() => {});
  }
  return true;
}
