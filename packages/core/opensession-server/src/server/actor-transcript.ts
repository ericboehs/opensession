import type { TranscriptEntry } from "./types";
import { publishTranscript } from "./transcript-bus";
import {
  notifyTranscriptAppendHook,
  type AppendResult,
  type DestinationTranscriptAppendRequest,
  type DestinationTranscriptAppendResult,
  type TailWindowOpts,
  type TranscriptImportInfo,
  type TranscriptOutline,
  type TranscriptPage,
  type TranscriptRangePage,
} from "./transcript-store";
import {
  sessionTranscript,
  type TranscriptActorRequest,
  type TranscriptMutationResult,
} from "./session-kernel";

async function reconcileMutation(
  sessionId: string,
  operation: "append" | "append_destination" | "import" | "replace" | "delete",
  mutation: TranscriptMutationResult<unknown>,
): Promise<void> {
  const wake = await sessionTranscript({ op: "pending_wake", sessionId });
  if (!wake || wake.cursor < mutation.wakeCursor) return;
  const reset = operation === "replace" || operation === "delete";
  const page = operation === "delete"
    ? { entries: [], firstSeq: 0, lastSeq: 0 }
    : await sessionTranscript({
        op: "changes_since",
        sessionId,
        changeSeq: Math.max(0, wake.firstChangeSeq - 1),
        limit: 10_000,
      });
  publishTranscript(sessionId, {
    entries: page.entries,
    firstSeq: page.firstSeq,
    lastSeq: page.lastSeq,
    ...(reset ? { reset: true } : {}),
  });
  if (page.entries.length) notifyTranscriptAppendHook(sessionId, page.entries);
  await sessionTranscript({ op: "ack_wake", sessionId, cursor: wake.cursor });
}

async function mutate<T>(
  request: Extract<TranscriptActorRequest, { requestId: string }>,
): Promise<T> {
  const mutation = await sessionTranscript(request) as TranscriptMutationResult<T>;
  await reconcileMutation(request.sessionId, request.op, mutation);
  return mutation.result;
}

export async function appendTranscriptEvents(
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<AppendResult | null> {
  return mutate({
    op: "append",
    sessionId,
    requestId: crypto.randomUUID(),
    entries,
  });
}

export async function appendTranscriptDestination(
  request: DestinationTranscriptAppendRequest,
): Promise<DestinationTranscriptAppendResult> {
  return mutate({
    op: "append_destination",
    sessionId: request.sessionId,
    requestId: `destination:${request.appendId}`,
    appendId: request.appendId,
    runId: request.runId,
    turnId: request.turnId,
    generation: request.generation,
    entries: request.entries,
  });
}

export async function importLegacyTranscript(
  sessionId: string,
  entries: TranscriptEntry[],
  src: string,
  watermark: number | null,
): Promise<{ inserted: number; updated: number }> {
  return mutate({
    op: "import",
    sessionId,
    requestId: crypto.randomUUID(),
    entries,
    src,
    watermark,
  });
}

export async function replaceTranscriptEvents(
  sessionId: string,
  entries: TranscriptEntry[],
  expectedEpoch?: number,
): Promise<{ inserted: number; updated: number }> {
  return mutate({
    op: "replace",
    sessionId,
    requestId: crypto.randomUUID(),
    entries,
    ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
  });
}

export async function deleteSessionTranscript(sessionId: string): Promise<void> {
  await mutate({
    op: "delete",
    sessionId,
    requestId: crypto.randomUUID(),
  });
}

export const transcript = {
  needsImport: (sessionId: string): Promise<boolean> =>
    sessionTranscript({ op: "needs_import", sessionId }),
  getImportInfo: (sessionId: string): Promise<TranscriptImportInfo | null> =>
    sessionTranscript({ op: "import_info", sessionId }),
  readTail: (sessionId: string, limit?: number): Promise<TranscriptPage> =>
    sessionTranscript({ op: "tail", sessionId, limit }),
  readTailWindow: (sessionId: string, options: TailWindowOpts): Promise<TranscriptPage> =>
    sessionTranscript({ op: "tail_window", sessionId, options }),
  readSince: (sessionId: string, sinceSeq: number, limit?: number): Promise<TranscriptPage> =>
    sessionTranscript({ op: "since", sessionId, sinceSeq, limit }),
  readChangesSince: (
    sessionId: string,
    changeSeq: number,
    limit?: number,
  ): Promise<TranscriptPage> =>
    sessionTranscript({ op: "changes_since", sessionId, changeSeq, limit }),
  readBefore: (sessionId: string, beforeSeq: number, limit?: number): Promise<TranscriptPage> =>
    sessionTranscript({ op: "before", sessionId, beforeSeq, limit }),
  readRange: (
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    afterSeq?: number,
    limit?: number,
  ): Promise<TranscriptRangePage> =>
    sessionTranscript({
      op: "range",
      sessionId,
      fromSeq,
      toSeq,
      afterSeq,
      limit,
    }),
  readTranscriptIndex: (sessionId: string): Promise<TranscriptOutline> =>
    sessionTranscript({ op: "outline", sessionId }),
  getFullEntry: (sessionId: string, entryId: string): Promise<TranscriptEntry | null> =>
    sessionTranscript({ op: "full_entry", sessionId, entryId }),
  getLastSeq: (sessionId: string): Promise<number> =>
    sessionTranscript({ op: "last_seq", sessionId }),
  getLastChangeSeq: (sessionId: string): Promise<number> =>
    sessionTranscript({ op: "last_change_seq", sessionId }),
  getLastResetChangeSeq: (sessionId: string): Promise<number> =>
    sessionTranscript({ op: "last_reset_change_seq", sessionId }),
  countEvents: (sessionId: string): Promise<number> =>
    sessionTranscript({ op: "count", sessionId }),
  search: (sessionId: string, query: string): Promise<string | null> =>
    sessionTranscript({ op: "search", sessionId, query }),
  appendTranscriptEvents,
  appendTranscriptDestination,
  importLegacyTranscript,
  replaceTranscriptEvents,
  deleteSessionTranscript,
};
