/**
 * Tool-less single-prompt helper backed by Pi.
 *
 * Callers use this for titles, branch names, classifiers, recaps, and the Dial
 * oracle. Every call gets a throwaway Pi session with no local or MCP tools.
 * It is fail-soft by contract: any model, timeout, or provider failure returns
 * null so each caller can keep its deterministic fallback.
 */
import { mkdirSync, rmSync } from "fs";
import { audit } from "./audit";
import {
  cancelPiRun,
  parsePiModel,
  PI_STATE_DIR,
  runPi,
} from "./pi-runner";
import { toPiModel, type SessionEffort } from "./models";

const DEFAULT_ONESHOT_MODEL = "pi/anthropic/claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const ONESHOT_CWD = `${PI_STATE_DIR}/oneshot`;

export interface OneShotOpts {
  /** Additional high-priority instructions injected into Pi's system context. */
  system?: string;
  /** Any native, OpenCode, or Pi model id. It is routed onto Pi. */
  model?: string;
  /** Account-affinity user for provider-pool selection. */
  user?: string;
  /** Call-site label for audit rows. */
  label?: string;
  effort?: SessionEffort;
  timeoutMs?: number;
}

/** Resolve one-shot model configuration onto Pi, preserving provider + tier. */
export function oneShotModel(model?: string): string | undefined {
  const requested =
    model || process.env.OPENSESSION_ONESHOT_MODEL || DEFAULT_ONESHOT_MODEL;
  return toPiModel(requested);
}

/** Run one tool-less Pi prompt and return its settled assistant text. */
export async function oneShot(
  prompt: string,
  opts: OneShotOpts = {},
): Promise<string | null> {
  // One-shots are real model calls. Import-heavy test suites rely on their
  // deterministic fallback paths and must never spend a model turn.
  if (process.env.NODE_ENV === "test") return null;

  const model = oneShotModel(opts.model);
  const label = opts.label || "oneshot";
  if (!model || !parsePiModel(model)) {
    console.warn(
      `[oneshot:${label}] model "${opts.model || ""}" does not resolve to Pi; skipping`,
    );
    return null;
  }

  mkdirSync(ONESHOT_CWD, { recursive: true });
  const runKey = `oneshot-${crypto.randomUUID()}`;
  const sessionDir = `${PI_STATE_DIR}/sessions/${runKey}`;
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  let text = "";
  let settled = "";
  let error = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelPiRun(runKey);
  }, timeoutMs);

  try {
    for await (const event of runPi(
      {
        prompt,
        // Supplying a private run key lets us remove Pi's native JSONL after
        // the call. No osSessionId means no Open Session transcript is made.
        sessionId: runKey,
        cwd: ONESHOT_CWD,
        mode: "ask",
        mcpServers: [],
        disableLocalWorkspaceTools: true,
        reposNote: opts.system
          ? `One-shot instructions (follow these for this response):\n${opts.system}`
          : "This is a tool-less one-shot text transformation. Return only the requested answer.",
        user: opts.user,
        effort: opts.effort,
        journal: { kind: "automation" },
      },
      model,
    )) {
      if (event.type === "text_chunk") text += event.text || "";
      if (event.type === "error") error = event.content || "Pi one-shot failed";
      if (event.type === "done") settled = event.result || text;
    }

    if (timedOut) error = `timed out after ${timeoutMs}ms`;
    const answer = (settled || text).trim();
    audit({
      msg: "pi_oneshot",
      label,
      model,
      status: error ? "error" : "ok",
      duration_ms: Date.now() - startedAt,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
    if (error) {
      console.warn(`[oneshot:${label}] failed: ${error}`);
      return null;
    }
    return answer || null;
  } catch (e) {
    const message = String((e as Error)?.message || e);
    console.warn(`[oneshot:${label}] failed: ${message}`);
    audit({
      msg: "pi_oneshot",
      label,
      model,
      status: "error",
      error: message.slice(0, 500),
      duration_ms: Date.now() - startedAt,
    });
    return null;
  } finally {
    clearTimeout(timer);
    // The generator has disposed the SDK session before this block runs.
    // A one-shot has no resume value, so its native JSONL must not accumulate.
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  }
}
