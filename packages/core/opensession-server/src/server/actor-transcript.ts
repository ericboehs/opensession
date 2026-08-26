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
  actorTranscriptSessionIds,
  sessionTranscript,
  type TranscriptActorRequest,
  type TranscriptMutationResult,
} from "./session-kernel";

async function callTranscript<T extends TranscriptActorRequest>(
  request: T,
): Promise<import("./session-kernel").TranscriptActorResult<T>> {
  if (process.env.NODE_ENV !== "test") return sessionTranscript(request);
  const { transcriptStore } = await import("./transcript-store");
  return transcriptStore().applyActorRequest(request) as
    import("./session-kernel").TranscriptActorResult<T>;
}

async function reconcileMutation(
  sessionId: string,
  operation: "append" | "append_destination" | "import" | "replace" | "delete",
  mutation: TranscriptMutationResult<unknown>,
): Promise<void> {
  const wake = await callTranscript({ op: "pending_wake", sessionId });
  if (!wake || wake.cursor < mutation.wakeCursor) return;
  const reset = operation === "replace" || operation === "delete";
  const page = operation === "delete"
    ? { entries: [], firstSeq: 0, lastSeq: 0 }
    : await callTranscript({
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
  await callTranscript({ op: "ack_wake", sessionId, cursor: wake.cursor });
}

async function mutate<T>(
  request: Extract<TranscriptActorRequest, { requestId: string }>,
): Promise<T> {
  const mutation = await callTranscript(request) as TranscriptMutationResult<T>;
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
    requestId: `transcript-destination:${request.appendId}`,
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
  const importId = crypto.randomUUID();
  let inserted = 0;
  let updated = 0;
  let finalMutation: TranscriptMutationResult<{ inserted: number; updated: number }> | null = null;
  const chunks = entries.length
    ? Array.from({ length: Math.ceil(entries.length / 500) }, (_, index) =>
        entries.slice(index * 500, (index + 1) * 500))
    : [[]];
  for (let index = 0; index < chunks.length; index++) {
    const final = index === chunks.length - 1;
    const mutation = await callTranscript({
      op: "import",
      sessionId,
      requestId: `import:${importId}:${index}`,
      entries: chunks[index]!,
      src,
      watermark,
      final,
    }) as TranscriptMutationResult<{ inserted: number; updated: number }>;
    inserted += mutation.result.inserted;
    updated += mutation.result.updated;
    finalMutation = mutation;
  }
  if (finalMutation) await reconcileMutation(sessionId, "import", finalMutation);
  return { inserted, updated };
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
    callTranscript({ op: "needs_import", sessionId }),
  getImportInfo: (sessionId: string): Promise<TranscriptImportInfo | null> =>
    callTranscript({ op: "import_info", sessionId }),
  readTail: (sessionId: string, limit?: number): Promise<TranscriptPage> =>
    callTranscript({ op: "tail", sessionId, limit }),
  readTailWindow: (sessionId: string, options: TailWindowOpts): Promise<TranscriptPage> =>
    callTranscript({ op: "tail_window", sessionId, options }),
  readSince: (sessionId: string, sinceSeq: number, limit?: number): Promise<TranscriptPage> =>
    callTranscript({ op: "since", sessionId, sinceSeq, limit }),
  readChangesSince: (
    sessionId: string,
    changeSeq: number,
    limit?: number,
  ): Promise<TranscriptPage> =>
    callTranscript({ op: "changes_since", sessionId, changeSeq, limit }),
  readBefore: (sessionId: string, beforeSeq: number, limit?: number): Promise<TranscriptPage> =>
    callTranscript({ op: "before", sessionId, beforeSeq, limit }),
  readRange: (
    sessionId: string,
    fromSeq: number,
    toSeq: number,
    afterSeq?: number,
    limit?: number,
  ): Promise<TranscriptRangePage> =>
    callTranscript({
      op: "range",
      sessionId,
      fromSeq,
      toSeq,
      afterSeq,
      limit,
    }),
  readTranscriptIndex: (sessionId: string): Promise<TranscriptOutline> =>
    callTranscript({ op: "outline", sessionId }),
  getFullEntry: (sessionId: string, entryId: string): Promise<TranscriptEntry | null> =>
    callTranscript({ op: "full_entry", sessionId, entryId }),
  getLastSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_seq", sessionId }),
  getLastChangeSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_change_seq", sessionId }),
  getLastResetChangeSeq: (sessionId: string): Promise<number> =>
    callTranscript({ op: "last_reset_change_seq", sessionId }),
  countEvents: (sessionId: string): Promise<number> =>
    callTranscript({ op: "count", sessionId }),
  summary: (
    sessionId: string,
  ): Promise<{ lastTs: number | null; seqHighWater: number } | null> =>
    callTranscript({ op: "summary", sessionId }),
  sessionIds: actorTranscriptSessionIds,
  search: (sessionId: string, query: string): Promise<string | null> =>
    callTranscript({ op: "search", sessionId, query }),
  appendTranscriptEvents,
  appendTranscriptDestination,
  importLegacyTranscript,
  replaceTranscriptEvents,
  deleteSessionTranscript,
};
