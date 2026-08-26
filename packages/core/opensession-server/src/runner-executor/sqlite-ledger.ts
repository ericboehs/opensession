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
import { dirname, parse, resolve } from "node:path";
import {
  decodeExecutorOperation,
  isExecutorOutcomeCompatible,
  type ExecutorOperationOutcome,
  type ExecutorReceipt,
  type ExecutorStreamEvent,
} from "@tellahq/opensession-protocol/executor";
import {
  LedgerConflictError,
  LedgerFullError,
  LedgerNotFoundError,
  LedgerScopeActiveError,
  LedgerScopeRetiredError,
  LedgerTransitionError,
  applyTransition,
  operationDigest,
  recoveryError,
  type DurableCommandLedger,
  type LedgerCommandIdentity,
  type LedgerRecord,
  type LedgerScope,
  type LedgerTerminalTransition,
} from "./ledger";

const SCHEMA_VERSION = 2;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const STATES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const ERROR_CODES = new Set([
  "invalid_request",
  "invalid_grant",
  "stale_generation",
  "deadline_exceeded",
  "not_found",
  "conflict",
  "cancelled",
  "operation_failed",
  "executor_busy",
  "unsupported",
]);
const encoder = new TextEncoder();

type StoredRow = {
  receipt_id: unknown;
  command_kind: unknown;
  command_key: unknown;
  executor_id: unknown;
  root_id: unknown;
  session_id: unknown;
  run_id: unknown;
  generation: unknown;
  request_id: unknown;
  operation_digest: unknown;
  state: unknown;
  accepted_at: unknown;
  completed_at: unknown;
  payload: unknown;
  ordinal: unknown;
};

export interface SQLiteCommandLedgerOptions {
  dbPath: string;
  capacity?: number;
  busyTimeoutMs?: number;
  maxRecordBytes?: number;
  maxStringBytes?: number;
  maxEvents?: number;
}
type Limits = Required<
  Pick<
    SQLiteCommandLedgerOptions,
    "maxRecordBytes" | "maxStringBytes" | "maxEvents"
  >
>;

export function openSQLiteCommandLedger(
  options: SQLiteCommandLedgerOptions,
): SQLiteCommandLedger {
  return SQLiteCommandLedger.open(options);
}

export class SQLiteCommandLedger implements DurableCommandLedger {
  readonly #db: Database;
  readonly #capacity: number;
  readonly #limits: Limits;
  #closed = false;

  private constructor(db: Database, capacity: number, limits: Limits) {
    this.#db = db;
    this.#capacity = capacity;
    this.#limits = limits;
  }

  static open(options: SQLiteCommandLedgerOptions): SQLiteCommandLedger {
    const capacity = positiveInteger(
      options.capacity ?? 100_000,
      "ledger capacity",
    );
    const busyTimeoutMs = positiveInteger(
      options.busyTimeoutMs ?? 5_000,
      "busy timeout",
    );
    const limits = {
      maxRecordBytes: positiveInteger(
        options.maxRecordBytes ?? 8 * 1024 * 1024,
        "record byte limit",
      ),
      maxStringBytes: positiveInteger(
        options.maxStringBytes ?? 256 * 1024,
        "string byte limit",
      ),
      maxEvents: positiveInteger(options.maxEvents ?? 4_096, "event limit"),
    };
    if (!options.dbPath || options.dbPath === ":memory:")
      throw new Error(
        "a filesystem database path is required for a durable ledger",
      );
    const dbPath = resolve(options.dbPath);
    preparePrivateDatabasePath(dbPath);
    preflightSidecars(dbPath);
    const db = new Database(dbPath, { create: true, strict: true });
    try {
      chmodSync(dbPath, 0o600);
      db.exec(
        `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`,
      );
      initializeOrValidateSchema(db);
      // Sidecars were checked before this pragma is allowed to create/open them.
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      secureDatabaseFiles(dbPath);
      return new SQLiteCommandLedger(db, capacity, limits);
    } catch (cause) {
      db.close();
      throw cause;
    }
  }

  async claim(
    identity: LedgerCommandIdentity,
    receipt: ExecutorReceipt,
  ): Promise<{ record: LedgerRecord; claimed: boolean }> {
    this.#assertOpen();
    const initial: LedgerRecord = { ...identity, receipt };
    const encoded = encodeRecord(initial, this.#limits);
    const kind = identity.idempotencyKey === undefined ? "request" : "mutation";
    const key = identity.idempotencyKey ?? identity.requestId;
    return this.#writeTransaction(() => {
      if (this.#isRetired(identity)) throw new LedgerScopeRetiredError();
      const existing = this.#selectCommand(identity, kind, key);
      if (existing) {
        const record = decodeRow(existing, this.#limits);
        if (record.operationDigest !== identity.operationDigest)
          throw new LedgerConflictError();
        return { record, claimed: false };
      }
      const collision = this.#selectReceipt(receipt.receiptId);
      if (collision) {
        decodeRow(collision, this.#limits);
        throw new LedgerConflictError(
          "receipt already belongs to another command",
        );
      }
      this.#makeRoom();
      const ordinal = (
        this.#db
          .query(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM runner_command_ledger",
          )
          .get() as { value: number }
      ).value;
      this.#db
        .query(
          `INSERT INTO runner_command_ledger
        (receipt_id, command_kind, command_key, executor_id, root_id, session_id, run_id, generation,
         request_id, operation_digest, state, accepted_at, completed_at, payload, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          receipt.receiptId,
          kind,
          key,
          identity.executorId,
          identity.rootId,
          identity.sessionId,
          identity.runId,
          identity.generation,
          identity.requestId,
          identity.operationDigest,
          receipt.state,
          receipt.acceptedAt,
          encoded,
          ordinal,
        );
      return { record: structuredClone(initial), claimed: true };
    });
  }

  async transition(
    scope: LedgerScope,
    receiptId: string,
    expected: "queued" | "running",
    next: { state: "running" } | LedgerTerminalTransition,
  ): Promise<LedgerRecord> {
    this.#assertOpen();
    validateScope(scope);
    validateId(receiptId, "receiptId");
    return this.#writeTransaction(() => {
      const row = this.#selectReceipt(receiptId);
      if (!row) throw new LedgerNotFoundError();
      const current = decodeRow(row, this.#limits);
      if (!sameScopeValues(current, scope)) throw new LedgerNotFoundError();
      if (current.receipt.state !== expected)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
      const updated = applyTransition(current, next);
      const encoded = encodeRecord(updated, this.#limits);
      const result = this.#db
        .query(
          `UPDATE runner_command_ledger SET state = ?, completed_at = ?, payload = ?
        WHERE receipt_id = ? AND executor_id = ? AND root_id = ? AND session_id = ? AND run_id = ? AND generation = ? AND state = ?`,
        )
        .run(
          updated.receipt.state,
          updated.receipt.completedAt ?? null,
          encoded,
          receiptId,
          scope.executorId,
          scope.rootId,
          scope.sessionId,
          scope.runId,
          scope.generation,
          expected,
        );
      if (result.changes !== 1)
        throw new LedgerTransitionError(
          current.receipt.state,
          expected,
          next.state,
        );
      return updated;
    });
  }

  async get(
    scope: LedgerScope,
    receiptId: string,
  ): Promise<LedgerRecord | undefined> {
    this.#assertOpen();
    validateScope(scope);
    validateId(receiptId, "receiptId");
    const row = this.#db
      .query(
        `SELECT * FROM runner_command_ledger WHERE receipt_id = ? AND executor_id = ?
      AND root_id = ? AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .get(
        receiptId,
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      ) as StoredRow | null;
    return row ? decodeRow(row, this.#limits) : undefined;
  }

  async recover(): Promise<number> {
    this.#assertOpen();
    return this.#writeTransaction(() => {
      const rows = this.#db
        .query(
          "SELECT * FROM runner_command_ledger WHERE state IN ('queued', 'running') ORDER BY ordinal",
        )
        .all() as StoredRow[];
      const completedAt = new Date().toISOString();
      for (const row of rows) {
        const current = decodeRow(row, this.#limits);
        const updated = applyTransition(current, {
          state: "failed",
          completedAt,
          error: recoveryError(current.idempotencyKey !== undefined),
        });
        this.#db
          .query(
            "UPDATE runner_command_ledger SET state = 'failed', completed_at = ?, payload = ? WHERE receipt_id = ? AND state = ?",
          )
          .run(
            completedAt,
            encodeRecord(updated, this.#limits),
            current.receipt.receiptId,
            current.receipt.state,
          );
      }
      return rows.length;
    });
  }

  async retireScope(scope: LedgerScope): Promise<number> {
    this.#assertOpen();
    validateScope(scope);
    return this.#writeTransaction(() => {
      const parameters = [
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      ] as const;
      const active = this.#db
        .query(
          `SELECT COUNT(*) AS count FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
          AND session_id = ? AND run_id = ? AND generation = ? AND state IN ('queued', 'running')`,
        )
        .get(...parameters) as { count: number };
      if (active.count) throw new LedgerScopeActiveError();
      const result = this.#db
        .query(
          `DELETE FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
          AND session_id = ? AND run_id = ? AND generation = ? AND state IN ('succeeded', 'failed', 'cancelled')`,
        )
        .run(...parameters);
      this.#db
        .query(
          `INSERT OR IGNORE INTO runner_retired_scopes
          (executor_id, root_id, session_id, run_id, generation) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(...parameters);
      return result.changes;
    });
  }

  async purgeRetiredScope(scope: LedgerScope): Promise<boolean> {
    this.#assertOpen();
    validateScope(scope);
    const result = this.#db
      .query(
        `DELETE FROM runner_retired_scopes WHERE executor_id = ? AND root_id = ?
        AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .run(
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      );
    return result.changes === 1;
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("command ledger is closed");
  }
  #isRetired(scope: LedgerScope): boolean {
    return !!this.#db
      .query(
        `SELECT 1 AS retired FROM runner_retired_scopes WHERE executor_id = ? AND root_id = ?
        AND session_id = ? AND run_id = ? AND generation = ?`,
      )
      .get(
        scope.executorId,
        scope.rootId,
        scope.sessionId,
        scope.runId,
        scope.generation,
      );
  }
  #selectReceipt(receiptId: string): StoredRow | null {
    return this.#db
      .query("SELECT * FROM runner_command_ledger WHERE receipt_id = ?")
      .get(receiptId) as StoredRow | null;
  }
  #selectCommand(
    identity: LedgerCommandIdentity,
    kind: string,
    key: string,
  ): StoredRow | null {
    return this.#db
      .query(
        `SELECT * FROM runner_command_ledger WHERE executor_id = ? AND root_id = ?
      AND session_id = ? AND run_id = ? AND generation = ? AND command_kind = ? AND command_key = ?`,
      )
      .get(
        identity.executorId,
        identity.rootId,
        identity.sessionId,
        identity.runId,
        identity.generation,
        kind,
        key,
      ) as StoredRow | null;
  }
  #makeRoom(): void {
    const count = (
      this.#db
        .query("SELECT COUNT(*) AS count FROM runner_command_ledger")
        .get() as { count: number }
    ).count;
    if (count < this.#capacity) return;
    const reclaim = this.#db
      .query(
        `SELECT receipt_id FROM runner_command_ledger
      WHERE command_kind = 'request' AND state IN ('succeeded', 'failed', 'cancelled') ORDER BY ordinal LIMIT 1`,
      )
      .get() as { receipt_id: string } | null;
    if (!reclaim) throw new LedgerFullError();
    this.#db
      .query("DELETE FROM runner_command_ledger WHERE receipt_id = ?")
      .run(reclaim.receipt_id);
  }
  #writeTransaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw cause;
    }
  }
}

function initializeOrValidateSchema(db: Database): void {
  const version = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  const userTables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const table = userTables.some(({ name }) => name === "runner_command_ledger");
  if (!table) {
    if (userTables.length)
      throw new Error("unknown existing ledger database tables");
    if (version !== 0)
      throw new Error(`unsupported ledger schema version ${version}`);
    db.exec(`CREATE TABLE runner_command_ledger (
      receipt_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL CHECK(command_kind IN ('request', 'mutation')),
      command_key TEXT NOT NULL, executor_id TEXT NOT NULL, root_id TEXT NOT NULL,
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
      request_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      accepted_at TEXT NOT NULL, completed_at TEXT, payload TEXT NOT NULL, ordinal INTEGER NOT NULL,
      UNIQUE(executor_id, root_id, session_id, run_id, generation, command_kind, command_key)
    ) STRICT;
    CREATE TABLE runner_retired_scopes (
      executor_id TEXT NOT NULL, root_id TEXT NOT NULL, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY(executor_id, root_id, session_id, run_id, generation)
    ) STRICT;
    PRAGMA user_version = ${SCHEMA_VERSION};`);
  } else if (version !== SCHEMA_VERSION) {
    throw new Error(
      version === 0
        ? "unversioned existing ledger table"
        : `unsupported ledger schema version ${version}`,
    );
  }
  const tableNames = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
  if (
    tableNames.length !== 2 ||
    !tableNames.includes("runner_command_ledger") ||
    !tableNames.includes("runner_retired_scopes")
  )
    throw new Error("ledger schema tables do not match version 2");
  const expected = [
    ["receipt_id", "TEXT", 1, 1],
    ["command_kind", "TEXT", 1, 0],
    ["command_key", "TEXT", 1, 0],
    ["executor_id", "TEXT", 1, 0],
    ["root_id", "TEXT", 1, 0],
    ["session_id", "TEXT", 1, 0],
    ["run_id", "TEXT", 1, 0],
    ["generation", "INTEGER", 1, 0],
    ["request_id", "TEXT", 1, 0],
    ["operation_digest", "TEXT", 1, 0],
    ["state", "TEXT", 1, 0],
    ["accepted_at", "TEXT", 1, 0],
    ["completed_at", "TEXT", 0, 0],
    ["payload", "TEXT", 1, 0],
    ["ordinal", "INTEGER", 1, 0],
  ];
  const actual = db
    .query("PRAGMA table_info(runner_command_ledger)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (
    actual.length !== expected.length ||
    actual.some((column, index) => {
      const wanted = expected[index]!;
      return (
        column.name !== wanted[0] ||
        column.type !== wanted[1] ||
        column.notnull !== wanted[2] ||
        column.pk !== wanted[3]
      );
    })
  )
    throw new Error("ledger schema columns do not match version 2");
  const retiredExpected = [
    ["executor_id", "TEXT", 1, 1],
    ["root_id", "TEXT", 1, 2],
    ["session_id", "TEXT", 1, 3],
    ["run_id", "TEXT", 1, 4],
    ["generation", "INTEGER", 1, 5],
  ];
  const retiredActual = db
    .query("PRAGMA table_info(runner_retired_scopes)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (
    retiredActual.length !== retiredExpected.length ||
    retiredActual.some((column, index) => {
      const wanted = retiredExpected[index]!;
      return (
        column.name !== wanted[0] ||
        column.type !== wanted[1] ||
        column.notnull !== wanted[2] ||
        column.pk !== wanted[3]
      );
    })
  )
    throw new Error("retired scope schema columns do not match version 2");
}

function encodeRecord(record: LedgerRecord, limits: Limits): string {
  validateRecord(record, limits);
  const encoded = JSON.stringify(record);
  if (encoder.encode(encoded).byteLength > limits.maxRecordBytes)
    throw new Error("ledger record exceeds byte limit");
  return encoded;
}
function decodeRow(row: StoredRow, limits: Limits): LedgerRecord {
  for (const key of [
    "receipt_id",
    "command_kind",
    "command_key",
    "executor_id",
    "root_id",
    "session_id",
    "run_id",
    "request_id",
    "operation_digest",
    "state",
    "accepted_at",
    "payload",
  ] as const)
    if (typeof row[key] !== "string") throw new Error("malformed ledger row");
  if (
    !Number.isSafeInteger(row.generation) ||
    !Number.isSafeInteger(row.ordinal) ||
    (row.completed_at !== null && typeof row.completed_at !== "string")
  )
    throw new Error("malformed ledger row");
  const payload = row.payload as string;
  if (encoder.encode(payload).byteLength > limits.maxRecordBytes)
    throw new Error("persisted ledger record exceeds byte limit");
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error("malformed ledger JSON");
  }
  validateRecord(value, limits);
  const record = value as LedgerRecord;
  const kind = record.idempotencyKey === undefined ? "request" : "mutation";
  const key = record.idempotencyKey ?? record.requestId;
  if (
    row.receipt_id !== record.receipt.receiptId ||
    row.command_kind !== kind ||
    row.command_key !== key ||
    row.executor_id !== record.executorId ||
    row.root_id !== record.rootId ||
    row.session_id !== record.sessionId ||
    row.run_id !== record.runId ||
    row.generation !== record.generation ||
    row.request_id !== record.requestId ||
    row.operation_digest !== record.operationDigest ||
    row.state !== record.receipt.state ||
    row.accepted_at !== record.receipt.acceptedAt ||
    row.completed_at !== (record.receipt.completedAt ?? null)
  )
    throw new Error("ledger row identity mismatch");
  return structuredClone(record);
}

function validateRecord(
  value: unknown,
  limits: Limits,
): asserts value is LedgerRecord {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "executorId",
      "rootId",
      "sessionId",
      "runId",
      "generation",
      "requestId",
      "idempotencyKey",
      "operationDigest",
      "operation",
      "receipt",
      "outcome",
      "events",
      "error",
    ])
  )
    throw new Error("invalid ledger record");
  validateScope(value as unknown as LedgerScope);
  validateId(value.requestId, "requestId");
  if (
    value.idempotencyKey !== undefined &&
    !boundedString(value.idempotencyKey, limits.maxStringBytes, true)
  )
    throw new Error("invalid idempotencyKey");
  if (
    typeof value.operationDigest !== "string" ||
    !DIGEST_RE.test(value.operationDigest)
  )
    throw new Error("invalid operation digest");
  const operation = decodeExecutorOperation(value.operation);
  if (
    !operation ||
    operationDigest(operation) !== value.operationDigest ||
    ("idempotencyKey" in operation ? operation.idempotencyKey : undefined) !==
      value.idempotencyKey
  )
    throw new Error("operation identity mismatch");
  validateReceipt(value.receipt, value.requestId, value.idempotencyKey);
  if (value.outcome !== undefined) {
    validateOutcome(value.outcome, limits);
    if (!isExecutorOutcomeCompatible(operation, value.outcome))
      throw new Error("executor outcome is incompatible with operation");
  }
  if (value.events !== undefined) {
    validateEvents(value.events, limits);
    const outcome = value.outcome as unknown;
    const streamId =
      plainObject(outcome) && typeof outcome.streamId === "string"
        ? outcome.streamId
        : undefined;
    if (!streamId || value.events.some((event) => event.streamId !== streamId))
      throw new Error("ledger event stream does not match outcome");
  }
  if (value.error !== undefined) validateError(value.error, limits);
  const state = (value.receipt as ExecutorReceipt).state;
  if (
    (state === "queued" || state === "running") &&
    (value.outcome !== undefined ||
      value.events !== undefined ||
      value.error !== undefined)
  )
    throw new Error("active record has terminal payload");
  if (
    state === "succeeded" &&
    (value.outcome === undefined || value.error !== undefined)
  )
    throw new Error("succeeded record is incoherent");
  if (
    (state === "failed" || state === "cancelled") &&
    (value.error === undefined ||
      value.outcome !== undefined ||
      value.events !== undefined)
  )
    throw new Error("failed record is incoherent");
}
function validateReceipt(
  value: unknown,
  requestId: string,
  key: string | undefined,
): asserts value is ExecutorReceipt {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "receiptId",
      "requestId",
      "state",
      "acceptedAt",
      "idempotencyKey",
      "completedAt",
    ])
  )
    throw new Error("invalid receipt");
  validateId(value.receiptId, "receiptId");
  const terminal =
    value.state === "succeeded" ||
    value.state === "failed" ||
    value.state === "cancelled";
  if (
    value.requestId !== requestId ||
    value.idempotencyKey !== key ||
    typeof value.state !== "string" ||
    !STATES.has(value.state) ||
    !isoDate(value.acceptedAt) ||
    terminal !== (value.completedAt !== undefined) ||
    (value.completedAt !== undefined && !isoDate(value.completedAt))
  )
    throw new Error("invalid receipt identity or fields");
}
function validateError(value: unknown, limits: Limits): void {
  if (
    !plainObject(value) ||
    !onlyKeys(value, ["code", "message", "ambiguous"]) ||
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code) ||
    !boundedString(value.message, limits.maxStringBytes, true) ||
    (value.ambiguous !== undefined && typeof value.ambiguous !== "boolean")
  )
    throw new Error("invalid ledger error");
}
function validateOutcome(
  value: unknown,
  limits: Limits,
): asserts value is ExecutorOperationOutcome {
  if (!plainObject(value) || typeof value.kind !== "string")
    throw new Error("invalid outcome");
  const id = (v: unknown) => boundedString(v, 256, true);
  if (
    value.kind === "fs.read" &&
    onlyKeys(value, ["kind", "streamId", "size", "binary"]) &&
    id(value.streamId) &&
    nonnegative(value.size) &&
    typeof value.binary === "boolean"
  )
    return;
  if (
    value.kind === "fs.list" &&
    onlyKeys(value, ["kind", "entries"]) &&
    Array.isArray(value.entries) &&
    value.entries.length <= limits.maxEvents &&
    value.entries.every(
      (e) =>
        plainObject(e) &&
        onlyKeys(e, ["path", "type", "size"]) &&
        boundedString(e.path, limits.maxStringBytes, true) &&
        ["file", "directory", "symlink"].includes(e.type as string) &&
        (e.size === undefined || nonnegative(e.size)),
    )
  )
    return;
  if (
    value.kind === "fs.stat" &&
    onlyKeys(value, ["kind", "entry"]) &&
    plainObject(value.entry) &&
    onlyKeys(value.entry, ["path", "type", "size", "modifiedAt"]) &&
    boundedString(value.entry.path, limits.maxStringBytes, true) &&
    ["file", "directory", "symlink"].includes(value.entry.type as string) &&
    nonnegative(value.entry.size) &&
    (value.entry.modifiedAt === undefined || isoDate(value.entry.modifiedAt))
  )
    return;
  if (
    value.kind === "fs.changed" &&
    onlyKeys(value, ["kind", "path"]) &&
    boundedString(value.path, limits.maxStringBytes, true)
  )
    return;
  const specs: Record<string, [string, string, string[], string]> = {
    process: [
      "processId",
      "state",
      ["starting", "running", "exited"],
      "exitCode",
    ],
    terminal: ["terminalId", "state", ["open", "closed"], ""],
    service: [
      "serviceId",
      "state",
      ["starting", "running", "stopped", "failed"],
      "",
    ],
    portal: ["portalId", "state", ["opening", "open", "closed", "failed"], ""],
  };
  const spec = specs[value.kind];
  if (spec) {
    const [idKey, stateKey, states, exitKey] = spec;
    const allowed = ["kind", idKey, stateKey];
    if (value.kind !== "portal") allowed.push("streamId");
    if (exitKey) allowed.push(exitKey);
    if (
      onlyKeys(value, allowed) &&
      id(value[idKey]) &&
      states.includes(value[stateKey] as string) &&
      (value.streamId === undefined || id(value.streamId)) &&
      (!exitKey ||
        value[exitKey] === undefined ||
        Number.isSafeInteger(value[exitKey]))
    )
      return;
  }
  throw new Error("invalid outcome");
}
function validateEvents(
  value: unknown,
  limits: Limits,
): asserts value is ExecutorStreamEvent[] {
  if (!Array.isArray(value) || value.length > limits.maxEvents)
    throw new Error("invalid ledger events");
  const sequences = new Map<string, number>();
  for (const event of value) {
    const previousSequence = plainObject(event)
      ? sequences.get(event.streamId as string)
      : undefined;
    if (
      !plainObject(event) ||
      !boundedString(event.streamId, 256, true) ||
      !nonnegative(event.sequence) ||
      (previousSequence !== undefined &&
        event.sequence !== previousSequence + 1)
    )
      throw new Error("invalid stream event sequence");
    sequences.set(event.streamId, event.sequence);
    const eof = event.eof === undefined || typeof event.eof === "boolean";
    if (
      event.kind === "text" &&
      onlyKeys(event, [
        "kind",
        "streamId",
        "sequence",
        "channel",
        "data",
        "eof",
      ]) &&
      ["stdout", "stderr", "terminal", "file"].includes(
        event.channel as string,
      ) &&
      boundedString(event.data, limits.maxStringBytes) &&
      eof
    )
      continue;
    if (
      event.kind === "exit" &&
      onlyKeys(event, ["kind", "streamId", "sequence", "exitCode", "signal"]) &&
      (event.exitCode === null || Number.isSafeInteger(event.exitCode)) &&
      (event.signal === undefined || boundedString(event.signal, 256, true))
    )
      continue;
    if (
      event.kind === "binary" &&
      onlyKeys(event, [
        "kind",
        "streamId",
        "sequence",
        "offset",
        "data",
        "metadata",
        "eof",
      ]) &&
      nonnegative(event.offset) &&
      boundedString(event.data, limits.maxStringBytes) &&
      eof &&
      validBinary(event)
    )
      continue;
    throw new Error("invalid stream event");
  }
}
function validBinary(event: Record<string, unknown>): boolean {
  const metadata = event.metadata;
  if (
    !plainObject(metadata) ||
    !onlyKeys(metadata, ["encoding", "byteLength", "mediaType", "sha256"]) ||
    metadata.encoding !== "base64" ||
    !nonnegative(metadata.byteLength) ||
    (metadata.mediaType !== undefined &&
      !boundedString(metadata.mediaType, 256, true)) ||
    (metadata.sha256 !== undefined &&
      (typeof metadata.sha256 !== "string" || !DIGEST_RE.test(metadata.sha256)))
  )
    return false;
  try {
    const decoded = Buffer.from(event.data as string, "base64");
    return (
      decoded.toString("base64") === event.data &&
      decoded.byteLength === metadata.byteLength
    );
  } catch {
    return false;
  }
}
function validateScope(value: LedgerScope): void {
  validateId(value.executorId, "executorId");
  validateId(value.rootId, "rootId");
  validateId(value.sessionId, "sessionId");
  validateId(value.runId, "runId");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0)
    throw new Error("invalid generation");
}
function sameScopeValues(a: LedgerScope, b: LedgerScope): boolean {
  return (
    a.executorId === b.executorId &&
    a.rootId === b.rootId &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.generation === b.generation
  );
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function boundedString(
  value: unknown,
  max: number,
  nonempty = false,
): value is string {
  return (
    typeof value === "string" &&
    (!nonempty || value.length > 0) &&
    encoder.encode(value).byteLength <= max
  );
}
function validateId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value))
    throw new Error(`invalid ${name}`);
}
function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    new Date(value).toISOString() === value
  );
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
function preparePrivateDatabasePath(dbPath: string): void {
  const parent = dirname(dbPath);
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
      throw new Error(`unsafe ledger path component: ${current}`);
  }
  chmodSync(parent, 0o700);
  const descriptor = openSync(
    dbPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("ledger database path is not a regular file");
    chmodSync(dbPath, 0o600);
  } finally {
    closeSync(descriptor);
  }
}
function preflightSidecars(path: string): void {
  // SQLite does not expose a no-follow VFS here. This narrows symlink races but
  // cannot defend against a malicious same-UID process replacing files later.
  for (const file of [`${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe ledger SQLite file: ${file}`);
    const descriptor = openSync(
      file,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`unsafe ledger SQLite file: ${file}`);
    } finally {
      closeSync(descriptor);
    }
  }
}
function secureDatabaseFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe ledger SQLite file: ${file}`);
    chmodSync(file, 0o600);
  }
}
export { SQLiteCommandLedger as SqliteCommandLedger };
