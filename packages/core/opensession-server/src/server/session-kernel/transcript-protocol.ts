import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "../types";
import type {
  AppendResult,
  DestinationTranscriptAppendResult,
  SeqEntry,
  TranscriptHydratedPage,
  TailWindowOpts,
  TranscriptImportInfo,
  TranscriptOutline,
  TranscriptPage,
  TranscriptRangePage,
} from "../transcript-store";

export const TRANSCRIPT_ACTOR_MAX_ENTRIES = 10_000;
export const TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_ACTOR_MAX_READ_LIMIT = 200;
export const TRANSCRIPT_ACTOR_OUTLINE_PAGE_LIMIT = 2_000;
const TRANSCRIPT_ACTOR_MAX_STRING_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_ACTOR_MAX_SCALARS = 250_000;

export type TranscriptMutationFence = {
  requestId: string;
  /** Reset epoch observed before a destructive replacement or deletion. */
  expectedEpoch?: number;
  runId?: string;
  turnId?: string;
  generation?: number;
};

type SessionRequest = { sessionId: string };
type MutationRequest = SessionRequest & TranscriptMutationFence;
export type TranscriptTailWindowOptions = Omit<TailWindowOpts, "weigh"> & {
  weightProfile?: "v2_snapshot" | "handoff";
};

export type TranscriptActorRequest =
  | (MutationRequest & { op: "append"; entries: TranscriptEntry[] })
  | (MutationRequest & {
      op: "append_destination";
      appendId: string;
      runId: string;
      turnId: string;
      generation: number;
      entries: TranscriptEntry[];
    })
  | (MutationRequest & {
      op: "import";
      entries: TranscriptEntry[];
      src: string;
      watermark: number | null;
      final?: boolean;
    })
  | (MutationRequest & { op: "replace"; entries: TranscriptEntry[] })
  | (MutationRequest & { op: "delete" })
  | (SessionRequest & { op: "needs_import" })
  | (SessionRequest & { op: "import_info" })
  | (SessionRequest & { op: "tail"; limit?: number })
  | (SessionRequest & { op: "tail_window"; options: TranscriptTailWindowOptions })
  | (SessionRequest & { op: "since"; sinceSeq: number; limit?: number })
  | (SessionRequest & { op: "changes_since"; changeSeq: number; limit?: number })
  | (SessionRequest & {
      op: "hydrated_since";
      sinceSeq: number;
      limit?: number;
      maxBytes: number;
    })
  | (SessionRequest & { op: "before"; beforeSeq: number; limit?: number })
  | (SessionRequest & {
      op: "range";
      fromSeq: number;
      toSeq: number;
      afterSeq?: number;
      limit?: number;
    })
  | (SessionRequest & { op: "outline"; afterSeq?: number; limit?: number })
  | (SessionRequest & { op: "full_entry"; entryId: string })
  | (SessionRequest & { op: "last_seq" })
  | (SessionRequest & { op: "last_change_seq" })
  | (SessionRequest & { op: "last_reset_change_seq" })
  | (SessionRequest & { op: "count" })
  | (SessionRequest & { op: "summary" })
  | (SessionRequest & { op: "pending_wake" })
  | (SessionRequest & { op: "ack_wake"; cursor: number });

export type TranscriptMutationResult<T> = {
  result: T;
  wakeCursor: number;
  replay: boolean;
};

export type TranscriptWake = {
  cursor: number;
  ackedCursor: number;
  firstChangeSeq: number;
  lastChangeSeq: number;
  resetEpoch: number;
  ackedResetEpoch: number;
};

export type TranscriptActorResult<T extends TranscriptActorRequest> =
  T extends { op: "append" }
    ? TranscriptMutationResult<AppendResult | null>
    : T extends { op: "append_destination" }
      ? TranscriptMutationResult<DestinationTranscriptAppendResult>
      : T extends { op: "import" | "replace" }
        ? TranscriptMutationResult<{ inserted: number; updated: number }>
        : T extends { op: "delete" }
          ? TranscriptMutationResult<void>
          : T extends { op: "needs_import" }
            ? boolean
            : T extends { op: "import_info" }
              ? TranscriptImportInfo | null
              : T extends { op: "tail" | "tail_window" | "since" | "changes_since" | "before" }
                ? TranscriptPage
                : T extends { op: "hydrated_since" }
                  ? TranscriptHydratedPage
                : T extends { op: "range" }
                  ? TranscriptRangePage
                  : T extends { op: "outline" }
                    ? TranscriptOutline
                    : T extends { op: "full_entry" }
                      ? TranscriptEntry | null
                      : T extends { op: "summary" }
                        ? { lastTs: number | null; seqHighWater: number } | null
                        : T extends { op: "pending_wake" }
                          ? TranscriptWake | null
                        : T extends { op: "ack_wake" }
                          ? boolean
                          : T extends { op: "last_seq" | "last_change_seq" | "last_reset_change_seq" | "count" }
                            ? number
                            : never;

export type TranscriptSearchHit = {
  sessionId: string;
  seq: number;
  entry: TranscriptIndexEntry | SeqEntry;
};

export function isTranscriptMutation(
  request: TranscriptActorRequest,
): request is Extract<TranscriptActorRequest, TranscriptMutationFence> {
  return ["append", "append_destination", "import", "replace", "delete"].includes(
    request.op,
  );
}

export function isTranscriptRead(request: TranscriptActorRequest): boolean {
  return !isTranscriptMutation(request) && request.op !== "ack_wake";
}

function wireBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Transcript actor payload is not JSON");
  return Buffer.byteLength(json);
}

function assertBoundedJson(value: unknown): void {
  let scalars = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new RangeError("Transcript actor payload is too deeply nested");
    if (item === null || typeof item === "boolean") {
      scalars++;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Transcript actor payload has a non-finite number");
      scalars++;
    } else if (typeof item === "string") {
      if (Buffer.byteLength(item) > TRANSCRIPT_ACTOR_MAX_STRING_BYTES)
        throw new RangeError("Transcript actor string is too large");
      scalars++;
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>))
        if (child !== undefined) visit(child, depth + 1);
    } else if (item !== undefined) {
      throw new TypeError("Transcript actor payload is not JSON");
    }
    if (scalars > TRANSCRIPT_ACTOR_MAX_SCALARS)
      throw new RangeError("Transcript actor payload has too many scalar values");
  };
  visit(value, 0);
}

function assertCursor(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new RangeError(`Transcript actor ${name} is invalid`);
}

/** Shared by the gateway preflight and the actor-owned store. */
export function assertTranscriptActorRequest(request: TranscriptActorRequest): void {
  if (!request || typeof request !== "object")
    throw new TypeError("Transcript actor request is invalid");
  if (!(new Set([
    "append", "append_destination", "import", "replace", "delete",
    "needs_import", "import_info", "tail", "tail_window", "since",
    "changes_since", "hydrated_since", "before", "range", "outline", "full_entry",
    "last_seq", "last_change_seq", "last_reset_change_seq", "count",
    "summary", "pending_wake", "ack_wake",
  ]) as Set<string>).has(request.op))
    throw new TypeError("Transcript actor operation is invalid");
  if (!request.sessionId || Buffer.byteLength(request.sessionId) > 1_024)
    throw new TypeError("Transcript actor request has an invalid session ID");
  if ("requestId" in request &&
      (!request.requestId || Buffer.byteLength(request.requestId) > 256))
    throw new RangeError("Transcript actor mutation identity is too large");
  if ("entries" in request &&
      (!Array.isArray(request.entries) || request.entries.length > TRANSCRIPT_ACTOR_MAX_ENTRIES))
    throw new RangeError("Transcript actor request has too many entries");
  for (const [name, value, ceiling] of [
    ["appendId", "appendId" in request ? request.appendId : undefined, 256],
    ["runId", "runId" in request ? request.runId : undefined, 1_024],
    ["turnId", "turnId" in request ? request.turnId : undefined, 1_024],
    ["src", "src" in request ? request.src : undefined, 1_024],
    ["entryId", "entryId" in request ? request.entryId : undefined, 1_024],
  ] as const) {
    if (value !== undefined &&
        (typeof value !== "string" || Buffer.byteLength(value) > ceiling))
      throw new RangeError(`Transcript actor ${name} is invalid`);
  }
  for (const [name, value] of [
    ["expectedEpoch", "expectedEpoch" in request ? request.expectedEpoch : undefined],
    ["generation", "generation" in request ? request.generation : undefined],
    ["watermark", "watermark" in request ? request.watermark ?? undefined : undefined],
  ] as const) assertCursor(value, name);
  if ("limit" in request && request.limit !== undefined) {
    const ceiling = request.op === "outline"
      ? TRANSCRIPT_ACTOR_OUTLINE_PAGE_LIMIT
      : TRANSCRIPT_ACTOR_MAX_READ_LIMIT;
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > ceiling)
      throw new RangeError("Transcript actor read limit is invalid");
  }
  if (request.op === "tail_window") {
    const options = request.options as TranscriptTailWindowOptions;
    if (
      typeof options !== "object" || options === null || "weigh" in options ||
      ("weightProfile" in options &&
        options.weightProfile !== "v2_snapshot" &&
        options.weightProfile !== "handoff")
    ) throw new TypeError("Transcript actor tail window options are invalid");
    const maxEntriesCeiling =
      options.weightProfile === "handoff" ? 512 : TRANSCRIPT_ACTOR_MAX_READ_LIMIT;
    for (const [name, value, ceiling] of [
      ["minEntries", options.minEntries, TRANSCRIPT_ACTOR_MAX_READ_LIMIT],
      ["minMessages", options.minMessages, TRANSCRIPT_ACTOR_MAX_READ_LIMIT],
      ["minUserMessagesWithToolWork", options.minUserMessagesWithToolWork ?? 0, TRANSCRIPT_ACTOR_MAX_READ_LIMIT],
      ["maxEntries", options.maxEntries, maxEntriesCeiling],
      ["maxEstimatedBytes", options.maxEstimatedBytes, TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > ceiling)
        throw new RangeError(`Transcript actor tail window ${name} is invalid`);
    }
    if (options.minEntries < 1 || options.maxEntries < 1 || options.minEntries > options.maxEntries)
      throw new RangeError("Transcript actor tail window entry bounds are invalid");
  }
  if (request.op === "since") assertCursor(request.sinceSeq, "sinceSeq");
  if (request.op === "changes_since") assertCursor(request.changeSeq, "changeSeq");
  if (request.op === "hydrated_since") {
    assertCursor(request.sinceSeq, "sinceSeq");
    if (
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 ||
      request.maxBytes > 12 * 1024 * 1024
    ) throw new RangeError("Transcript actor hydrated page byte limit is invalid");
  }
  if (request.op === "before") assertCursor(request.beforeSeq, "beforeSeq");
  if (request.op === "range") {
    assertCursor(request.fromSeq, "fromSeq");
    assertCursor(request.toSeq, "toSeq");
    assertCursor(request.afterSeq, "afterSeq");
    if (request.toSeq < request.fromSeq)
      throw new RangeError("Transcript actor range is invalid");
  }
  if (request.op === "outline") assertCursor(request.afterSeq, "afterSeq");
  if (request.op === "ack_wake") assertCursor(request.cursor, "wake cursor");
  assertBoundedJson(request);
  if (wireBytes(request) > TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES)
    throw new RangeError("Transcript actor request exceeds the wire byte limit");
}

export function assertTranscriptActorResponse(result: unknown): void {
  assertBoundedJson(result);
  if (wireBytes(result) > TRANSCRIPT_ACTOR_MAX_RESPONSE_BYTES)
    throw new RangeError("Transcript actor response exceeds the wire byte limit");
}
