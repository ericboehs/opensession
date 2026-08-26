import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "../types";
import type {
  AppendResult,
  DestinationTranscriptAppendResult,
  SeqEntry,
  TailWindowOpts,
  TranscriptImportInfo,
  TranscriptOutline,
  TranscriptPage,
  TranscriptRangePage,
} from "../transcript-store";

export const TRANSCRIPT_ACTOR_MAX_ENTRIES = 10_000;
export const TRANSCRIPT_ACTOR_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const TRANSCRIPT_ACTOR_MAX_READ_LIMIT = 10_000;

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
  | (SessionRequest & { op: "tail_window"; options: TailWindowOpts })
  | (SessionRequest & { op: "since"; sinceSeq: number; limit?: number })
  | (SessionRequest & { op: "changes_since"; changeSeq: number; limit?: number })
  | (SessionRequest & { op: "before"; beforeSeq: number; limit?: number })
  | (SessionRequest & {
      op: "range";
      fromSeq: number;
      toSeq: number;
      afterSeq?: number;
      limit?: number;
    })
  | (SessionRequest & { op: "outline" })
  | (SessionRequest & { op: "full_entry"; entryId: string })
  | (SessionRequest & { op: "last_seq" })
  | (SessionRequest & { op: "last_change_seq" })
  | (SessionRequest & { op: "last_reset_change_seq" })
  | (SessionRequest & { op: "count" })
  | (SessionRequest & { op: "summary" })
  | (SessionRequest & { op: "search"; query: string })
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
                : T extends { op: "range" }
                  ? TranscriptRangePage
                  : T extends { op: "outline" }
                    ? TranscriptOutline
                    : T extends { op: "full_entry" }
                      ? TranscriptEntry | null
                      : T extends { op: "summary" }
                        ? { lastTs: number | null; seqHighWater: number } | null
                        : T extends { op: "search" }
                          ? string | null
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
