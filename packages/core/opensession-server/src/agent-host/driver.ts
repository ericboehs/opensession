import type {
  AgentTurnSpec,
  AskResult,
  ImageInput,
  StreamEvent,
  TranscriptEntry,
} from "@tellahq/opensession-protocol";

export type AgentTurnResult =
  { status: "completed" | "cancelled" } | { status: "failed"; error: string };

/** The driver's output surface. Persistence remains in the control plane. */
export interface AgentTurnOutput {
  event(event: StreamEvent): void;
  proposeTranscript(appendId: string, entries: TranscriptEntry[]): void;
  ask(askId: string, input: Record<string, unknown>): void;
}

/** One model-loop implementation for one turn. Executor access is only the
 * opaque grant inside spec; model-loop authority never moves to Executor. */
export interface AgentTurnDriver {
  run(spec: AgentTurnSpec, output: AgentTurnOutput): Promise<AgentTurnResult>;
  steer(input: {
    steerId: string;
    text: string;
    images?: ImageInput[];
  }): void | Promise<void>;
  answer(askId: string, result: AskResult): void | Promise<void>;
  cancel(): void | Promise<void>;
  transcriptAck(appendId: string, changeSeq: number): void | Promise<void>;
  shutdown(): void | Promise<void>;
}

export type AgentTurnDriverFactory = (spec: AgentTurnSpec) => AgentTurnDriver;
