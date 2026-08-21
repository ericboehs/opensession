import type { WSClientMessage } from "./types";

const MUTATION_TYPES = new Set<WSClientMessage["type"]>([
  "prompt",
  "interrupt_prompt",
  "delete_queued_prompt",
  "take_queued_prompt",
  "take_steered_prompt",
  "update_queued_prompt",
  "steer_queued_prompt",
  "interrupt_queued_prompt",
  "reorder_queued_prompt",
  "cancel",
  "answer_question",
  "create_session",
]);

type MessageWithRequestId = WSClientMessage & { requestId?: string };

/** Stamp an intent once, before it enters the reconnect outbox. */
export function withMutationRequestId(
  message: WSClientMessage,
): WSClientMessage {
  if (!MUTATION_TYPES.has(message.type)) return message;
  const mutation = message as MessageWithRequestId;
  if (mutation.requestId) return message;
  return { ...message, requestId: crypto.randomUUID() } as WSClientMessage;
}
