import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, parse, resolve } from "node:path";
import {
  AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN,
  decodeAgentOperationDescriptorV1,
  decodeAgentOperationReceiptV1,
  serializeAgentOperationDescriptorV1,
  serializeAgentOperationReceiptV1,
  type AgentOperationReceiptV1,
} from "@tellahq/opensession-protocol/agent-operation";
import {
  AgentOperationConflictError,
  AgentOperationLedgerFullError,
  AgentOperationNotFoundError,
  AgentOperationSessionActiveError,
  AgentOperationTransitionError,
  type AgentOperationIdentity,
  type AgentOperationIndeterminateReason,
  type AgentOperationLedger,
  type AgentOperationQuarantineReason,
  type AgentOperationRecord,
  type AgentOperationSettlement,
} from "./ledger";

const SCHEMA_VERSION = 1;
const MAX_ID_BYTES = 512;
const DEFAULT_MAX_ROW_BYTES = 256 * 1024;
const TABLE_SQL = `CREATE TABLE agent_operation_receipts (
  session_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','mcp')),
  run_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
  plan_hash TEXT NOT NULL, authority_hash TEXT NOT NULL, descriptor_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
  adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','executing','settled','indeterminate')),
  accepted_at INTEGER NOT NULL, executing_at INTEGER, completed_at INTEGER,
  descriptor_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
  quarantine_reason TEXT CHECK(quarantine_reason IN ('claim_identity_mismatch','get_identity_mismatch','transition_identity_mismatch')),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id,operation_id)
) STRICT`;
const ACTIVE_INDEX_SQL =
  "CREATE INDEX agent_operation_active ON agent_operation_receipts(state,ordinal) WHERE state IN ('prepared','executing')";
const encoder = new TextEncoder();
class CommittedConflict extends Error {}
type Row = {
  session_id: unknown;
  operation_id: unknown;
  kind: unknown;
  run_id: unknown;
  turn_id: unknown;
  generation: unknown;
  plan_hash: unknown;
  authority_hash: unknown;
  descriptor_digest: unknown;
  payload_digest: unknown;
  adapter_id: unknown;
  adapter_version: unknown;
  state: unknown;
  accepted_at: unknown;
  executing_at: unknown;
  completed_at: unknown;
  descriptor_json: unknown;
  receipt_json: unknown;
  quarantine_reason: unknown;
  ordinal: unknown;
};
export interface SQLiteAgentOperationLedgerOptions {
  dbPath: string;
  capacity?: number;
  busyTimeoutMs?: number;
  maxRowBytes?: number;
}

export class SQLiteAgentOperationLedger implements AgentOperationLedger {
  readonly #db: Database;
  readonly #capacity: number;
  readonly #maxRowBytes: number;
  readonly #path: string;
  #closed = false;

  constructor(options: SQLiteAgentOperationLedgerOptions) {
    if (!options.dbPath || options.dbPath === ":memory:")
      throw new Error(
        "a filesystem database path is required for the Agent operation ledger",
      );
    this.#capacity = positive(options.capacity ?? 100_000, "capacity");
    this.#maxRowBytes = positive(
      options.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
      "row byte limit",
    );
    const timeout = positive(options.busyTimeoutMs ?? 5_000, "busy timeout");
    this.#path = resolve(options.dbPath);
    preparePrivatePath(this.#path);
    preflightSidecars(this.#path);
    const db = new Database(this.#path, { create: true, strict: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${timeout}; PRAGMA foreign_keys = ON;`);
      initialize(db);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      secureFiles(this.#path);
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async claimPrepared(
    identity: AgentOperationIdentity,
    acceptedAtMs: number,
  ): Promise<{ record: AgentOperationRecord; claimed: boolean }> {
    this.#open();
    validateIdentity(identity);
    validTime(acceptedAtMs, "acceptedAtMs");
    const receipt: AgentOperationReceiptV1 = {
      version: 1,
      operationId: identity.operationId,
      kind: identity.kind,
      fence: identity.fence,
      planHash: identity.planHash,
      authorityHash: identity.authorityHash,
      descriptorDigest: identity.descriptorDigest,
      payloadDigest: identity.payloadDigest,
      state: "prepared",
      acceptedAtMs,
      providerRef: {
        adapterId: identity.adapterId,
        adapterVersion: identity.adapterVersion,
      },
    };
    const record = { ...identity, receipt };
    const descriptorJson = canonicalDescriptorJson(identity);
    const receiptJson = encodeReceipt(receipt, this.#maxRowBytes);
    rowLimit(descriptorJson, receiptJson, this.#maxRowBytes);
    return this.#transaction(() => {
      const existing = this.#select(
        identity.fence.sessionId,
        identity.operationId,
      );
      if (existing) {
        const decoded = decodeRow(existing, this.#maxRowBytes);
        if (!sameIdentity(decoded, identity))
          this.#conflict(identity, "claim_identity_mismatch");
        if (decoded.quarantineReason)
          throw new AgentOperationConflictError(
            "agent operation is quarantined",
          );
        return { record: decoded, claimed: false };
      }
      const count = this.#db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM agent_operation_receipts")
        .get()!.count;
      if (count >= this.#capacity) throw new AgentOperationLedgerFullError();
      const ordinal = this.#db
        .query<
          { value: number },
          []
        >("SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM agent_operation_receipts")
        .get()!.value;
      this.#db
        .query(
          `INSERT INTO agent_operation_receipts
        (session_id,operation_id,kind,run_id,turn_id,generation,plan_hash,authority_hash,descriptor_digest,payload_digest,
         adapter_id,adapter_version,state,accepted_at,executing_at,completed_at,descriptor_json,receipt_json,quarantine_reason,ordinal)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,?)`,
        )
        .run(
          identity.fence.sessionId,
          identity.operationId,
          identity.kind,
          identity.fence.runId,
          identity.fence.turnId,
          identity.fence.generation,
          identity.planHash,
          identity.authorityHash,
          identity.descriptorDigest,
          identity.payloadDigest,
          identity.adapterId,
          identity.adapterVersion,
          "prepared",
          acceptedAtMs,
          descriptorJson,
          receiptJson,
          ordinal,
        );
      return { record: structuredClone(record), claimed: true };
    });
  }

  async markExecuting(
    identity: AgentOperationIdentity,
    executingAtMs: number,
  ): Promise<AgentOperationRecord> {
    validTime(executingAtMs, "executingAtMs");
    return this.#transition(identity, "prepared", "executing", (current) => ({
      ...current.receipt,
      state: "executing",
      executingAtMs,
    }));
  }
  async settle(
    identity: AgentOperationIdentity,
    settlement: AgentOperationSettlement,
  ): Promise<AgentOperationRecord> {
    validTime(settlement.completedAtMs, "completedAtMs");
    return this.#transition(identity, "executing", "settled", (current) => ({
      ...current.receipt,
      state: "settled",
      completedAtMs: settlement.completedAtMs,
      outcome: settlement.outcome,
      transcriptRefs: settlement.transcriptRefs,
      providerRef: {
        adapterId: current.adapterId,
        adapterVersion: current.adapterVersion,
        ...(settlement.providerRequestRef === undefined
          ? {}
          : { requestId: settlement.providerRequestRef }),
        ...(settlement.providerResponseRef === undefined
          ? {}
          : { responseId: settlement.providerResponseRef }),
      },
    }));
  }
  async markIndeterminate(
    identity: AgentOperationIdentity,
    reason: AgentOperationIndeterminateReason,
    completedAtMs: number,
  ): Promise<AgentOperationRecord> {
    validTime(completedAtMs, "completedAtMs");
    const code =
      reason === "reconciliation_unsupported" ||
      reason === "reconciliation_failed" ||
      reason === "ambiguous_completion"
        ? reason
        : "ambiguous_completion";
    return this.#transition(
      identity,
      "executing",
      "indeterminate",
      (current) => ({
        ...current.receipt,
        state: "indeterminate",
        completedAtMs,
        errorCode: code,
      }),
    );
  }
  async getExact(
    identity: AgentOperationIdentity,
  ): Promise<AgentOperationRecord | undefined> {
    this.#open();
    validateIdentity(identity);
    const row = this.#select(identity.fence.sessionId, identity.operationId);
    if (!row) return undefined;
    const record = decodeRow(row, this.#maxRowBytes);
    if (!sameIdentity(record, identity)) {
      this.#transaction(() =>
        this.#conflict(identity, "get_identity_mismatch"),
      );
    }
    return record;
  }
  async scanActive(): Promise<AgentOperationRecord[]> {
    this.#open();
    return (
      this.#db
        .query(
          "SELECT * FROM agent_operation_receipts WHERE state IN ('prepared','executing') AND quarantine_reason IS NULL ORDER BY ordinal",
        )
        .all() as Row[]
    ).map((row) => decodeRow(row, this.#maxRowBytes));
  }
  async retireSession(sessionId: string): Promise<number> {
    this.#open();
    validText(sessionId, "sessionId");
    return this.#transaction(() => {
      const active = this.#db
        .query<
          { count: number },
          [string]
        >("SELECT COUNT(*) AS count FROM agent_operation_receipts WHERE session_id=? AND state IN ('prepared','executing')")
        .get(sessionId)!.count;
      if (active) throw new AgentOperationSessionActiveError();
      return this.#db
        .query("DELETE FROM agent_operation_receipts WHERE session_id=?")
        .run(sessionId).changes;
    });
  }
  async deleteSession(sessionId: string): Promise<number> {
    this.#open();
    validText(sessionId, "sessionId");
    return this.#transaction(
      () =>
        this.#db
          .query("DELETE FROM agent_operation_receipts WHERE session_id=?")
          .run(sessionId).changes,
    );
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
    secureFiles(this.#path);
  }

  #transition(
    identity: AgentOperationIdentity,
    expected: "prepared" | "executing",
    next: "executing" | "settled" | "indeterminate",
    update: (record: AgentOperationRecord) => AgentOperationReceiptV1,
  ): Promise<AgentOperationRecord> {
    this.#open();
    validateIdentity(identity);
    return Promise.resolve(
      this.#transaction(() => {
        const row = this.#select(
          identity.fence.sessionId,
          identity.operationId,
        );
        if (!row) throw new AgentOperationNotFoundError();
        const current = decodeRow(row, this.#maxRowBytes);
        if (!sameIdentity(current, identity))
          this.#conflict(identity, "transition_identity_mismatch");
        if (current.quarantineReason)
          throw new AgentOperationConflictError(
            "agent operation is quarantined",
          );
        if (current.receipt.state !== expected)
          throw new AgentOperationTransitionError(current.receipt.state, next);
        const receipt = update(current);
        const receiptJson = encodeReceipt(receipt, this.#maxRowBytes);
        rowLimit(
          canonicalDescriptorJson(current),
          receiptJson,
          this.#maxRowBytes,
        );
        const result = this.#db
          .query(
            "UPDATE agent_operation_receipts SET state=?, executing_at=?, completed_at=?, receipt_json=? WHERE session_id=? AND operation_id=? AND state=?",
          )
          .run(
            receipt.state,
            receipt.executingAtMs ?? null,
            receipt.completedAtMs ?? null,
            receiptJson,
            identity.fence.sessionId,
            identity.operationId,
            expected,
          );
        if (result.changes !== 1)
          throw new AgentOperationTransitionError(current.receipt.state, next);
        return { ...current, receipt };
      }),
    );
  }
  #conflict(
    identity: AgentOperationIdentity,
    reason: AgentOperationQuarantineReason,
  ): never {
    this.#db
      .query(
        "UPDATE agent_operation_receipts SET quarantine_reason=COALESCE(quarantine_reason, ?) WHERE session_id=? AND operation_id=?",
      )
      .run(reason, identity.fence.sessionId, identity.operationId);
    throw new CommittedConflict();
  }
  #select(sessionId: string, operationId: string): Row | null {
    return this.#db
      .query(
        "SELECT * FROM agent_operation_receipts WHERE session_id=? AND operation_id=?",
      )
      .get(sessionId, operationId) as Row | null;
  }
  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.#db.exec("COMMIT;");
      return result;
    } catch (error) {
      if (error instanceof CommittedConflict) {
        this.#db.exec("COMMIT;");
        throw new AgentOperationConflictError();
      }
      try {
        this.#db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
  }
  #open(): void {
    if (this.#closed) throw new Error("Agent operation ledger is closed");
  }
}

function decodeRow(row: Row, max: number): AgentOperationRecord {
  for (const field of [row.descriptor_json, row.receipt_json])
    if (typeof field !== "string" || encoder.encode(field).byteLength > max)
      throw new Error("corrupt Agent operation ledger row");
  let descriptorValue: unknown;
  let receiptValue: unknown;
  try {
    descriptorValue = JSON.parse(row.descriptor_json as string);
    receiptValue = JSON.parse(row.receipt_json as string);
  } catch {
    throw new Error("corrupt Agent operation ledger JSON");
  }
  const descriptor = decodeAgentOperationDescriptorV1(descriptorValue);
  const receipt = decodeAgentOperationReceiptV1(receiptValue);
  if (
    !descriptor ||
    !receipt ||
    typeof row.session_id !== "string" ||
    typeof row.operation_id !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.run_id !== "string" ||
    typeof row.turn_id !== "string" ||
    !Number.isSafeInteger(row.generation) ||
    typeof row.plan_hash !== "string" ||
    typeof row.authority_hash !== "string" ||
    typeof row.descriptor_digest !== "string" ||
    typeof row.payload_digest !== "string" ||
    typeof row.adapter_id !== "string" ||
    typeof row.adapter_version !== "string" ||
    typeof row.state !== "string" ||
    receipt.state !== row.state ||
    descriptor.kind !== row.kind
  )
    throw new Error("corrupt Agent operation ledger row");
  const identity = {
    operationId: row.operation_id,
    kind: row.kind,
    fence: {
      sessionId: row.session_id,
      runId: row.run_id,
      turnId: row.turn_id,
      generation: row.generation,
    },
    planHash: row.plan_hash,
    authorityHash: row.authority_hash,
    descriptor,
    descriptorDigest: row.descriptor_digest,
    payloadDigest: row.payload_digest,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
  } as AgentOperationIdentity;
  validateIdentity(identity);
  if (
    receipt.operationId !== identity.operationId ||
    receipt.kind !== identity.kind ||
    receipt.planHash !== identity.planHash ||
    receipt.authorityHash !== identity.authorityHash ||
    receipt.descriptorDigest !== identity.descriptorDigest ||
    receipt.payloadDigest !== identity.payloadDigest ||
    receipt.providerRef.adapterId !== identity.adapterId ||
    receipt.providerRef.adapterVersion !== identity.adapterVersion ||
    JSON.stringify(receipt.fence) !== JSON.stringify(identity.fence) ||
    row.accepted_at !== receipt.acceptedAtMs ||
    row.executing_at !== (receipt.executingAtMs ?? null) ||
    row.completed_at !== (receipt.completedAtMs ?? null) ||
    !Number.isSafeInteger(row.ordinal) ||
    (row.ordinal as number) < 1 ||
    row.descriptor_json !== canonicalDescriptorJson(identity) ||
    row.receipt_json !== encodeReceipt(receipt, max)
  )
    throw new Error("tampered Agent operation ledger receipt");
  if (
    row.quarantine_reason !== null &&
    row.quarantine_reason !== "claim_identity_mismatch" &&
    row.quarantine_reason !== "get_identity_mismatch" &&
    row.quarantine_reason !== "transition_identity_mismatch"
  )
    throw new Error("corrupt Agent operation ledger quarantine");
  const quarantineReason =
    row.quarantine_reason as AgentOperationQuarantineReason | null;
  return {
    ...identity,
    receipt,
    ...(quarantineReason === null ? {} : { quarantineReason }),
  };
}
function canonicalDescriptorJson(identity: AgentOperationIdentity): string {
  const bytes = serializeAgentOperationDescriptorV1(identity.descriptor);
  const recomputed = `sha256:${createHash("sha256")
    .update(`${AGENT_OPERATION_DESCRIPTOR_DIGEST_DOMAIN}\0`)
    .update(bytes)
    .digest("hex")}`;
  if (recomputed !== identity.descriptorDigest)
    throw new TypeError(
      "descriptor digest does not match canonical descriptor",
    );
  return new TextDecoder().decode(bytes);
}
function sameIdentity(
  a: AgentOperationIdentity,
  b: AgentOperationIdentity,
): boolean {
  return (
    a.operationId === b.operationId &&
    a.kind === b.kind &&
    a.fence.sessionId === b.fence.sessionId &&
    a.fence.runId === b.fence.runId &&
    a.fence.turnId === b.fence.turnId &&
    a.fence.generation === b.fence.generation &&
    a.planHash === b.planHash &&
    a.authorityHash === b.authorityHash &&
    a.descriptorDigest === b.descriptorDigest &&
    a.payloadDigest === b.payloadDigest &&
    a.adapterId === b.adapterId &&
    a.adapterVersion === b.adapterVersion &&
    canonicalDescriptorJson(a) === canonicalDescriptorJson(b)
  );
}
function validateIdentity(v: AgentOperationIdentity): void {
  for (const [name, value] of [
    ["operationId", v.operationId],
    ["sessionId", v.fence.sessionId],
    ["runId", v.fence.runId],
    ["turnId", v.fence.turnId],
    ["adapterId", v.adapterId],
    ["adapterVersion", v.adapterVersion],
  ] as const)
    validText(value, name);
  if (!Number.isSafeInteger(v.fence.generation) || v.fence.generation < 1)
    throw new TypeError("invalid generation");
  if (v.descriptor.kind !== v.kind)
    throw new TypeError("descriptor kind mismatch");
  canonicalDescriptorJson(v);
  for (const value of [
    v.planHash,
    v.authorityHash,
    v.descriptorDigest,
    v.payloadDigest,
  ])
    if (!/^sha256:[a-f0-9]{64}$/.test(value))
      throw new TypeError("invalid digest");
}
function validText(v: string, name: string): void {
  if (
    !v ||
    encoder.encode(v).byteLength > MAX_ID_BYTES ||
    v.trim() !== v ||
    /[\u0000-\u001f\u007f]/u.test(v)
  )
    throw new TypeError(`invalid ${name}`);
}
function validTime(v: number, name: string): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`invalid ${name}`);
}
function positive(v: number, name: string): number {
  if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`invalid ${name}`);
  return v;
}
function encodeReceipt(v: AgentOperationReceiptV1, max: number): string {
  const bytes = serializeAgentOperationReceiptV1(v);
  if (bytes.byteLength > max) throw new AgentOperationLedgerFullError();
  return new TextDecoder().decode(bytes);
}
function rowLimit(...args: [string, string, number]): void {
  const [a, b, max] = args;
  if (encoder.encode(a).byteLength + encoder.encode(b).byteLength > max)
    throw new AgentOperationLedgerFullError();
}

function normalizeSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/gu, "").replace(/;+$/u, "").toLowerCase();
}
function initialize(db: Database): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  if (version !== 0 && version !== SCHEMA_VERSION)
    throw new Error(`unsupported Agent operation ledger schema: ${version}`);
  if (version === 0) {
    const tables = db
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (tables.length)
      throw new Error(
        "unversioned Agent operation ledger schema is unsupported",
      );
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(
        `${TABLE_SQL}; ${ACTIVE_INDEX_SQL}; PRAGMA user_version=${SCHEMA_VERSION};`,
      );
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((v) => v.name);
  if (tables.join() !== "agent_operation_receipts")
    throw new Error("Agent operation ledger schema tables do not match");
  const tableList = db
    .query<
      { name: string; type: string; ncol: number; wr: number; strict: number },
      []
    >("PRAGMA table_list")
    .all()
    .find((row) => row.name === "agent_operation_receipts");
  if (
    !tableList ||
    tableList.type !== "table" ||
    tableList.ncol !== 20 ||
    tableList.wr !== 0 ||
    tableList.strict !== 1
  )
    throw new Error("Agent operation ledger table is not exact STRICT schema");
  const columns = db
    .query<
      {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
        hidden: number;
      },
      []
    >("PRAGMA table_xinfo('agent_operation_receipts')")
    .all();
  const names = [
    "session_id",
    "operation_id",
    "kind",
    "run_id",
    "turn_id",
    "generation",
    "plan_hash",
    "authority_hash",
    "descriptor_digest",
    "payload_digest",
    "adapter_id",
    "adapter_version",
    "state",
    "accepted_at",
    "executing_at",
    "completed_at",
    "descriptor_json",
    "receipt_json",
    "quarantine_reason",
    "ordinal",
  ];
  const nullable = new Set([
    "executing_at",
    "completed_at",
    "quarantine_reason",
  ]);
  if (
    columns.length !== names.length ||
    columns.some(
      (column, index) =>
        column.name !== names[index] ||
        column.type !==
          ([
            "generation",
            "accepted_at",
            "executing_at",
            "completed_at",
            "ordinal",
          ].includes(column.name)
            ? "INTEGER"
            : "TEXT") ||
        column.notnull !== (nullable.has(column.name) ? 0 : 1) ||
        column.dflt_value !== null ||
        column.hidden !== 0 ||
        column.pk !==
          (column.name === "session_id"
            ? 1
            : column.name === "operation_id"
              ? 2
              : 0),
    )
  )
    throw new Error("Agent operation ledger schema columns do not match");
  const objects = db
    .query<
      { name: string; type: string; sql: string | null },
      []
    >("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all();
  if (
    objects.length !== 2 ||
    objects[0]?.name !== "agent_operation_active" ||
    objects[0]?.type !== "index" ||
    normalizeSql(objects[0].sql) !== normalizeSql(ACTIVE_INDEX_SQL) ||
    objects[1]?.name !== "agent_operation_receipts" ||
    objects[1]?.type !== "table" ||
    normalizeSql(objects[1].sql) !== normalizeSql(TABLE_SQL)
  )
    throw new Error("Agent operation ledger schema objects do not match");
  const check = db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .get();
  if (check?.integrity_check !== "ok")
    throw new Error("Agent operation ledger integrity check failed");
}
function preparePrivatePath(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = parse(parent).root;
  let current = root;
  for (const part of parent
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `unsafe Agent operation ledger path component: ${current}`,
      );
  }
  chmodSync(parent, 0o700);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("Agent operation ledger path is not a regular file");
    chmodSync(path, 0o600);
  } finally {
    closeSync(fd);
  }
}
function preflightSidecars(path: string): void {
  for (const file of [`${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe Agent operation ledger SQLite file: ${file}`);
    const fd = openSync(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile())
        throw new Error(`unsafe Agent operation ledger SQLite file: ${file}`);
      chmodSync(file, 0o600);
    } finally {
      closeSync(fd);
    }
  }
}
function secureFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe Agent operation ledger SQLite file: ${file}`);
    chmodSync(file, 0o600);
  }
}
