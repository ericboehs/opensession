/**
 * Deterministic fake engine for token-free tests.
 *
 * Implements the INNER engine contract that `runOnModel` dispatches to (see
 * agent-runner.ts `EngineRunner`): emit `init` → text/tool events → exactly
 * one terminal `done`/`error`, then return. Installed via
 * `__setEngineForTest(fake.engine)` so the whole consumer stack — runAgent's
 * fallback walk, runSessionPrompt's event loop, queue drain, run-state
 * transitions — runs for real with zero model spend and no live engine.
 *
 * Each engine invocation consumes the next scripted turn; running past the
 * script yields a loud terminal error rather than hanging or silently
 * succeeding. Calls are recorded on `calls` for assertions.
 *
 * Journal fidelity: like the real runOpencode, a turn with
 * `opts.journal.bksSessionId` registers in the run journal for its duration
 * (journalSet → run_registered → journalClear), so FSM/busy/journal consumers
 * see the same lifecycle a real run produces. Point the journal at a temp file
 * first (`__setActiveRunsPathForTest`) in tests that use this.
 */
import type { EngineRunner, RunAgentOpts } from "../agent-runner";
import type { StreamEvent, TurnUsage } from "../run-events";
import { journalClear, journalSet } from "../run-journal";

export type FakeTurn =
  | {
      kind: "clean";
      /** init.sessionId — defaults to a stable per-call fake id. */
      engineSessionId?: string;
      /** One text_chunk per element. */
      text?: string[];
      tools?: Array<{
        name: string;
        input?: Record<string, unknown>;
        result?: string;
      }>;
      usage?: Partial<TurnUsage>;
      /** Awaited before the terminal done — lets a test hold the turn open
       *  (session busy) while it enqueues follow-ups or asserts mid-run state. */
      gate?: Promise<void>;
    }
  | {
      kind: "error";
      content: string;
      usageLimitExhausted?: boolean;
      /** Skip the init event — models a failure before the engine session
       *  exists (e.g. account pool dry at pick time). */
      noInit?: boolean;
      engineSessionId?: string;
    }
  | {
      /** A `done` with usageLimitExhausted:true — what a pool-drained clean
       *  stop looks like; drives runAgent's fallback walk. */
      kind: "usage_exhausted";
      engineSessionId?: string;
    }
  | {
      /** Fully scripted event list, yielded verbatim. */
      kind: "events";
      events: StreamEvent[];
    };

export interface FakeCall {
  prompt: string;
  model: string;
  sessionId?: string;
  journalKind?: string;
  seedEntries?: number;
}

export interface FakeEngine {
  engine: EngineRunner;
  /** One entry per engine invocation, in order. */
  calls: FakeCall[];
}

const DEFAULT_USAGE: TurnUsage = {
  costUsd: 0,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  contextTokens: 150,
};

export function makeFakeEngine(turns: FakeTurn[]): FakeEngine {
  const calls: FakeCall[] = [];

  async function* engine(
    opts: RunAgentOpts,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    const callIndex = calls.length;
    calls.push({
      prompt: opts.prompt,
      model,
      sessionId: opts.sessionId,
      journalKind: opts.journal?.kind,
      seedEntries: opts.seedTranscriptEntries?.length,
    });
    const turn = turns[callIndex];
    if (!turn) {
      yield {
        type: "error",
        content: `fake engine script exhausted (call ${callIndex + 1} of ${turns.length})`,
      };
      return;
    }
    if (turn.kind === "events") {
      yield* turn.events;
      return;
    }

    const engineSessionId =
      turn.engineSessionId || opts.sessionId || `fake-ses-${callIndex + 1}`;
    const bks = opts.journal?.bksSessionId;
    const runKey = bks ? `fake-${bks}` : null;
    if (runKey) {
      journalSet({
        runKey,
        bksSessionId: bks,
        claudeSessionId: engineSessionId,
        cwd: opts.cwd,
        kind: opts.journal?.kind,
        model,
        selectedModel: opts.selectedModel,
        transientFallback: opts.transientFallback,
        startedAt: new Date().toISOString(),
      });
    }
    try {
      if (turn.kind === "error") {
        if (!turn.noInit) {
          yield {
            type: "init",
            sessionId: engineSessionId,
            provider: "opencode",
            model,
          };
        }
        yield {
          type: "error",
          content: turn.content,
          usageLimitExhausted: turn.usageLimitExhausted,
        };
        return;
      }

      yield {
        type: "init",
        sessionId: engineSessionId,
        provider: "opencode",
        model,
      };
      if (turn.kind === "usage_exhausted") {
        yield {
          type: "done",
          sessionId: engineSessionId,
          provider: "opencode",
          model,
          usage: DEFAULT_USAGE,
          usageLimitExhausted: true,
        };
        return;
      }

      for (const text of turn.text ?? []) {
        yield { type: "text_chunk", text };
      }
      let toolIndex = 0;
      for (const tool of turn.tools ?? []) {
        const toolUseId = `fake-tool-${callIndex + 1}-${++toolIndex}`;
        yield {
          type: "tool_use",
          toolName: tool.name,
          toolInput: tool.input ?? {},
          toolUseId,
        };
        yield {
          type: "tool_result",
          content: tool.result ?? "(ok)",
          toolUseId,
        };
      }
      if (turn.gate) await turn.gate;
      yield {
        type: "done",
        sessionId: engineSessionId,
        provider: "opencode",
        model,
        usage: { ...DEFAULT_USAGE, ...turn.usage },
      };
    } finally {
      if (runKey) journalClear(runKey);
    }
  }

  return { engine, calls };
}
