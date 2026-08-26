import { decodeAgentOperationReceiptV1 } from "@tellahq/opensession-protocol/agent-operation";
import type {
  AgentAdapterReconciliationProofV1,
  AgentOperationDescriptorV1,
  AgentOperationDigest,
  AgentOperationKind,
  AgentOperationOutcomeV1,
  AgentOperationReceiptV1,
  AgentOperationState,
  AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";

export interface AgentOperationIdentity {
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  planHash: AgentOperationDigest;
  authorityHash: AgentOperationDigest;
  descriptor: AgentOperationDescriptorV1;
  descriptorDigest: AgentOperationDigest;
  payloadDigest: AgentOperationDigest;
  adapterId: string;
  adapterVersion: string;
}
export type AgentOperationQuarantineReason =
  | "claim_identity_mismatch"
  | "get_identity_mismatch"
  | "transition_identity_mismatch";
export interface AgentOperationRecord extends AgentOperationIdentity {
  receipt: AgentOperationReceiptV1;
  quarantineReason?: AgentOperationQuarantineReason;
}
export interface AgentOperationSettlement {
  completedAtMs: number;
  outcome: AgentOperationOutcomeV1;
  transcriptRefs?: readonly AgentTranscriptReceiptRefV1[];
  providerRequestRef?: string;
  providerResponseRef?: string;
}
export type AgentOperationIndeterminateReason =
  | "reconciliation_unsupported"
  | "reconciliation_failed"
  | "ambiguous_completion"
  | "identity_mismatch"
  | "cancellation_ambiguous"
  | "timeout_ambiguous"
  | "disconnect_ambiguous";

export interface AgentOperationLedger {
  claimPrepared(
    identity: AgentOperationIdentity,
    acceptedAtMs: number,
  ): Promise<{ record: AgentOperationRecord; claimed: boolean }>;
  markExecuting(
    identity: AgentOperationIdentity,
    executingAtMs: number,
  ): Promise<AgentOperationRecord>;
  settle(
    identity: AgentOperationIdentity,
    settlement: AgentOperationSettlement,
  ): Promise<AgentOperationRecord>;
  markIndeterminate(
    identity: AgentOperationIdentity,
    reason: AgentOperationIndeterminateReason,
    completedAtMs: number,
  ): Promise<AgentOperationRecord>;
  /** Both the primary key and every expected identity field are required. */
  getExact(
    identity: AgentOperationIdentity,
  ): Promise<AgentOperationRecord | undefined>;
  scanActive(): Promise<AgentOperationRecord[]>;
  retireSession(sessionId: string): Promise<number>;
  deleteSession(sessionId: string): Promise<number>;
  close(): Promise<void>;
}

export class AgentOperationConflictError extends Error {
  constructor(message = "agent operation identity conflict") {
    super(message);
    this.name = "AgentOperationConflictError";
  }
}
export class AgentOperationNotFoundError extends Error {
  constructor() {
    super("agent operation not found for exact identity");
    this.name = "AgentOperationNotFoundError";
  }
}
export class AgentOperationTransitionError extends Error {
  constructor(current: AgentOperationState, next: AgentOperationState) {
    super(`illegal agent operation transition: ${current} -> ${next}`);
    this.name = "AgentOperationTransitionError";
  }
}
export class AgentOperationLedgerFullError extends Error {
  constructor() {
    super("agent operation ledger is full");
    this.name = "AgentOperationLedgerFullError";
  }
}
export class AgentOperationSessionActiveError extends Error {
  constructor() {
    super("cannot retire a session with active agent operations");
    this.name = "AgentOperationSessionActiveError";
  }
}

export interface ExecutingOperationReconciler {
  reconcile(record: AgentOperationRecord): Promise<
    | {
        status: "settled";
        proof: AgentAdapterReconciliationProofV1;
        settlement: AgentOperationSettlement;
      }
    | { status: "not_started"; proof: AgentAdapterReconciliationProofV1 }
    | {
        status: "indeterminate";
        reason:
          | "reconciliation_unsupported"
          | "reconciliation_failed"
          | "ambiguous_completion";
      }
  >;
}
/**
 * Recover one inherited executing operation. There is deliberately no retry path:
 * not_started proof is retained as indeterminate because executing was committed
 * before invocation and this foundation cannot roll state backward.
 */
export async function reconcileExecutingOperation(
  ledger: AgentOperationLedger,
  record: AgentOperationRecord,
  reconciler: ExecutingOperationReconciler | undefined,
  completedAtMs: number,
): Promise<AgentOperationRecord> {
  if (record.receipt.state !== "executing")
    throw new AgentOperationTransitionError(
      record.receipt.state,
      "indeterminate",
    );
  const failClosed = async (
    reason:
      | "reconciliation_unsupported"
      | "reconciliation_failed"
      | "ambiguous_completion",
  ): Promise<AgentOperationRecord> => {
    try {
      return await ledger.markIndeterminate(record, reason, completedAtMs);
    } catch (error) {
      const latest = await ledger.getExact(record);
      if (
        latest &&
        (latest.receipt.state === "settled" ||
          latest.receipt.state === "indeterminate")
      )
        return latest;
      throw error;
    }
  };
  if (!reconciler) return failClosed("reconciliation_unsupported");
  let result: unknown;
  try {
    // Snapshot once so adapter accessors/Proxies cannot change shape between
    // runtime validation and durable settlement.
    result = structuredClone(await reconciler.reconcile(record));
  } catch {
    return failClosed("reconciliation_failed");
  }
  if (!plain(result) || typeof result.status !== "string")
    return failClosed("reconciliation_failed");
  if (result.status === "settled") {
    if (
      !exact(result, ["status", "proof", "settlement"]) ||
      !proofMatches(record, result.proof) ||
      !validSettlement(record, result.settlement) ||
      !plain(result.proof) ||
      result.proof.providerRequestRef !==
        (result.settlement as AgentOperationSettlement).providerRequestRef ||
      result.proof.providerResponseRef !==
        (result.settlement as AgentOperationSettlement).providerResponseRef
    )
      return failClosed("reconciliation_failed");
    try {
      return await ledger.settle(
        record,
        result.settlement as AgentOperationSettlement,
      );
    } catch {
      return failClosed("reconciliation_failed");
    }
  }
  if (result.status === "not_started") {
    if (
      !exact(result, ["status", "proof"]) ||
      !proofMatches(record, result.proof)
    )
      return failClosed("reconciliation_failed");
    return failClosed("ambiguous_completion");
  }
  if (
    result.status === "indeterminate" &&
    exact(result, ["status", "reason"]) &&
    (result.reason === "reconciliation_unsupported" ||
      result.reason === "reconciliation_failed" ||
      result.reason === "ambiguous_completion")
  )
    return failClosed(result.reason);
  return failClosed("reconciliation_failed");
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
function proofMatches(
  record: AgentOperationRecord,
  candidate: unknown,
): candidate is AgentAdapterReconciliationProofV1 {
  if (
    !plain(candidate) ||
    !Object.keys(candidate).every((key) =>
      [
        "adapterId",
        "adapterVersion",
        "operationId",
        "kind",
        "fence",
        "planHash",
        "authorityHash",
        "descriptorDigest",
        "payloadDigest",
        "providerRequestRef",
        "providerResponseRef",
      ].includes(key),
    ) ||
    !plain(candidate.fence)
  )
    return false;
  const proof = candidate as unknown as AgentAdapterReconciliationProofV1;
  return (
    proof.adapterId === record.adapterId &&
    proof.adapterVersion === record.adapterVersion &&
    proof.operationId === record.operationId &&
    proof.kind === record.kind &&
    proof.fence.sessionId === record.fence.sessionId &&
    proof.fence.runId === record.fence.runId &&
    proof.fence.turnId === record.fence.turnId &&
    proof.fence.generation === record.fence.generation &&
    proof.planHash === record.planHash &&
    proof.authorityHash === record.authorityHash &&
    proof.descriptorDigest === record.descriptorDigest &&
    proof.payloadDigest === record.payloadDigest &&
    (proof.providerRequestRef === undefined ||
      typeof proof.providerRequestRef === "string") &&
    (proof.providerResponseRef === undefined ||
      typeof proof.providerResponseRef === "string")
  );
}
function validSettlement(
  record: AgentOperationRecord,
  candidate: unknown,
): candidate is AgentOperationSettlement {
  if (
    !plain(candidate) ||
    !Object.keys(candidate).every((key) =>
      [
        "completedAtMs",
        "outcome",
        "transcriptRefs",
        "providerRequestRef",
        "providerResponseRef",
      ].includes(key),
    )
  )
    return false;
  return !!decodeAgentOperationReceiptV1({
    ...record.receipt,
    state: "settled",
    completedAtMs: candidate.completedAtMs,
    outcome: candidate.outcome,
    ...(candidate.transcriptRefs === undefined
      ? {}
      : { transcriptRefs: candidate.transcriptRefs }),
    providerRef: {
      adapterId: record.adapterId,
      adapterVersion: record.adapterVersion,
      ...(candidate.providerRequestRef === undefined
        ? {}
        : { requestId: candidate.providerRequestRef }),
      ...(candidate.providerResponseRef === undefined
        ? {}
        : { responseId: candidate.providerResponseRef }),
    },
  });
}
