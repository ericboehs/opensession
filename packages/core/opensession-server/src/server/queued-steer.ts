import {
  currentAgentRunToken,
  interruptAndSteerAgentRunToken,
  steerAgentRunToken,
} from "./agent-runner";
import {
  acceptQueuedSteer,
  prepareQueuedSteer,
  rejectQueuedSteer,
  type QueueItem,
} from "./queue-state";
import type { ImageInput } from "./run-events";
import { sessionKernel } from "./session-kernel";

type QueuedSteerFence = {
  token: string;
  runId: string;
  generation: number;
};

export type QueuedSteerDeps = {
  target(sessionId: string): QueuedSteerFence | undefined;
  prepare(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
    directItem?: QueueItem,
  ): Promise<QueueItem | undefined>;
  steer(
    token: string,
    text: string,
    images: ImageInput[] | undefined,
    itemId: string,
  ): boolean;
  accept(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
  ): Promise<boolean>;
  reject(
    sessionId: string,
    itemId: string,
    target: QueuedSteerFence,
  ): Promise<boolean>;
};

const queuedSteerDeps: QueuedSteerDeps = {
  target(sessionId) {
    const token = currentAgentRunToken(sessionId);
    const run = sessionKernel(sessionId).runState();
    if (!token || !run.currentRunId) return undefined;
    return { token, runId: run.currentRunId, generation: run.generation };
  },
  prepare: prepareQueuedSteer,
  steer: steerAgentRunToken,
  accept: acceptQueuedSteer,
  reject: rejectQueuedSteer,
};

function sameFence(
  before: QueuedSteerFence,
  after: QueuedSteerFence | undefined,
): boolean {
  return !!after &&
    after.token === before.token &&
    after.runId === before.runId &&
    after.generation === before.generation;
}

/** Prepare durably, then steer only the immutable run captured before await. */
export async function prepareAndSteerQueuedPrompt(
  input: {
    sessionId: string;
    itemId: string;
    item?: QueueItem;
    text: string;
    images?: ImageInput[];
  },
  deps: QueuedSteerDeps = queuedSteerDeps,
): Promise<"steered" | "rejected" | "not_prepared"> {
  const before = deps.target(input.sessionId);
  if (!before) return "not_prepared";
  const prepared = await deps.prepare(
    input.sessionId,
    input.itemId,
    before,
    input.item,
  );
  if (!prepared) return "not_prepared";
  if (!sameFence(before, deps.target(input.sessionId))) {
    if (!await deps.reject(input.sessionId, input.itemId, before))
      throw new Error("Pending steer changed before fenced rejection");
    return "rejected";
  }
  if (!deps.steer(before.token, input.text, input.images, input.itemId)) {
    if (!await deps.reject(input.sessionId, input.itemId, before))
      throw new Error("Pending steer changed before fenced rejection");
    return "rejected";
  }
  if (!await deps.accept(input.sessionId, input.itemId, before))
    throw new Error("Pending steer changed before runner acceptance");
  return "steered";
}

/** Prepare durably, then interrupt only the immutable run captured before await. */
export async function prepareAndInterruptQueuedPrompt(
  input: {
    sessionId: string;
    itemId: string;
    text: string;
    images?: ImageInput[];
  },
  deps: QueuedSteerDeps = {
    ...queuedSteerDeps,
    steer: (token, text, images) =>
      interruptAndSteerAgentRunToken(token, text, images),
  },
): Promise<"interrupted" | "target_changed" | "unsupported" | "not_prepared"> {
  const before = deps.target(input.sessionId);
  if (!before) return "not_prepared";
  const prepared = await deps.prepare(input.sessionId, input.itemId, before);
  if (!prepared) return "not_prepared";
  if (!sameFence(before, deps.target(input.sessionId))) {
    if (!await deps.reject(input.sessionId, input.itemId, before))
      throw new Error("Pending interrupt steer changed before fenced rejection");
    return "target_changed";
  }
  if (!deps.steer(before.token, input.text, input.images, input.itemId)) {
    if (!await deps.reject(input.sessionId, input.itemId, before))
      throw new Error("Pending interrupt steer changed before fenced rejection");
    return "unsupported";
  }
  if (!await deps.accept(input.sessionId, input.itemId, before))
    throw new Error("Pending interrupt steer changed before runner acceptance");
  return "interrupted";
}
