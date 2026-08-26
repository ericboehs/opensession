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
import { EXECUTOR_PROVIDER_IDS, type ExecutorProviderId } from "./provider";
import {
  ExecutorStateConflictError,
  type ExecutorAuditEntry,
  type ExecutorLifecycle,
  type ExecutorRecord,
  type ExecutorStateStore,
} from "./state";

const LIFECYCLES = [
  "preparing",
  "awake",
  "sleeping",
  "waking",
  "needs_attention",
] as const satisfies readonly ExecutorLifecycle[];

interface ExecutorRow {
  executor_id: unknown;
  session_id: unknown;
  provider: unknown;
  resource_id: unknown;
  workspace_id: unknown;
  resource_generation: unknown;
  instance_generation: unknown;
  lifecycle: unknown;
  project_revision: unknown;
  project_base_commit: unknown;
  project_durable_delta: unknown;
  created_at_ms: unknown;
  updated_at_ms: unknown;
  error: unknown;
}

interface AuditRow {
  executor_id: unknown;
  generation: unknown;
  action: unknown;
  operator_id: unknown;
  reason: unknown;
  at_ms: unknown;
}

const RECORD_COLUMNS = `
  executor_id, session_id, provider, resource_id, workspace_id,
  resource_generation, instance_generation, lifecycle,
  project_revision, project_base_commit, project_durable_delta,
  created_at_ms, updated_at_ms, error
`;

const SCHEMA_VERSION = 2;
const RECORD_COLUMN_NAMES = [
  "executor_id",
  "session_id",
  "provider",
  "resource_id",
  "workspace_id",
  "resource_generation",
  "instance_generation",
  "lifecycle",
  "project_revision",
  "project_base_commit",
  "project_durable_delta",
  "created_at_ms",
  "updated_at_ms",
  "error",
] as const;
const AUDIT_COLUMN_NAMES = [
  "id",
  "executor_id",
  "generation",
  "action",
  "operator_id",
  "reason",
  "at_ms",
] as const;

/**
 * Durable managed Executor state. Construction is the explicit open boundary;
 * merely importing this module performs no filesystem or database work.
 */
export class SqliteExecutorStateStore implements ExecutorStateStore {
  readonly #db: Database;

  constructor(readonly dbPath: string) {
    if (typeof dbPath !== "string" || dbPath.length === 0) {
      throw new TypeError("Executor state database path must be explicit");
    }
    if (dbPath !== ":memory:") {
      preparePrivateDatabasePath(dbPath);
      preflightSidecars(dbPath);
    }

    let db: Database | undefined;
    try {
      db = new Database(dbPath);
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec("PRAGMA journal_mode = WAL;");
      // Executor intent and audit records fence external provider side effects.
      db.exec("PRAGMA synchronous = FULL;");
      initializeSchema(db);
      if (dbPath !== ":memory:") secureSqliteFiles(dbPath);
      this.#db = db;
    } catch (error) {
      db?.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  async getByExecutorId(
    executorId: string,
  ): Promise<ExecutorRecord | undefined> {
    assertIdentity(executorId, "executorId");
    const row = this.#db
      .query<ExecutorRow, [string]>(
        `SELECT ${RECORD_COLUMNS} FROM managed_executors WHERE executor_id = ?`,
      )
      .get(executorId);
    return row ? decodeRecord(row) : undefined;
  }

  async getBySessionId(sessionId: string): Promise<ExecutorRecord | undefined> {
    assertIdentity(sessionId, "sessionId");
    const row = this.#db
      .query<ExecutorRow, [string]>(
        `SELECT ${RECORD_COLUMNS} FROM managed_executors WHERE session_id = ?`,
      )
      .get(sessionId);
    return row ? decodeRecord(row) : undefined;
  }

  async insertIntent(record: ExecutorRecord): Promise<void> {
    assertRecord(record);
    const insert = this.#db.transaction(() => {
      if (this.#hasExecutor(record.executorId)) {
        throw new ExecutorStateConflictError(
          `Executor ${record.executorId} already exists`,
        );
      }
      if (this.#hasSession(record.sessionId)) {
        throw new ExecutorStateConflictError(
          `session ${record.sessionId} already has a managed Executor`,
        );
      }
      this.#insertRecord(record);
    });
    insert.immediate();
  }

  async compareAndSwap(
    executorId: string,
    expectedGeneration: number,
    next: ExecutorRecord,
  ): Promise<void> {
    assertIdentity(executorId, "executorId");
    assertGeneration(expectedGeneration, "expectedGeneration");
    assertRecord(next);
    if (next.executorId !== executorId) {
      throw new ExecutorStateConflictError("Executor identity is immutable");
    }
    if (
      next.instanceGeneration < expectedGeneration ||
      next.instanceGeneration > expectedGeneration + 1
    ) {
      throw new ExecutorStateConflictError(
        "Executor generation must remain current or advance exactly once",
      );
    }

    const swap = this.#db.transaction(() => {
      const current = this.#getRawByExecutor(executorId);
      if (!current) {
        throw new ExecutorStateConflictError(
          `Executor ${executorId} does not exist`,
        );
      }
      const decoded = decodeRecord(current);
      if (decoded.instanceGeneration !== expectedGeneration) {
        throw staleConflict(executorId, expectedGeneration);
      }
      if (next.sessionId !== decoded.sessionId) {
        throw new ExecutorStateConflictError(
          "Executor and session identity are immutable",
        );
      }
      if (next.createdAtMs !== decoded.createdAtMs) {
        throw new ExecutorStateConflictError(
          "Executor creation timestamp is immutable",
        );
      }
      if (next.updatedAtMs < decoded.updatedAtMs) {
        throw new ExecutorStateConflictError(
          "Executor update timestamp cannot move backward",
        );
      }
      this.#db
        .query(
          `UPDATE managed_executors SET
            provider = ?, resource_id = ?, workspace_id = ?,
            resource_generation = ?, instance_generation = ?, lifecycle = ?,
            project_revision = ?, project_base_commit = ?, project_durable_delta = ?,
            created_at_ms = ?, updated_at_ms = ?, error = ?
           WHERE executor_id = ? AND instance_generation = ?`,
        )
        .run(...recordValuesForUpdate(next), executorId, expectedGeneration);
    });
    swap.immediate();
  }

  async delete(executorId: string, expectedGeneration: number): Promise<void> {
    assertIdentity(executorId, "executorId");
    assertGeneration(expectedGeneration, "expectedGeneration");
    const remove = this.#db.transaction(() => {
      const current = this.#getRawByExecutor(executorId);
      if (!current) {
        throw new ExecutorStateConflictError(
          `Executor ${executorId} does not exist`,
        );
      }
      const decoded = decodeRecord(current);
      if (decoded.instanceGeneration !== expectedGeneration) {
        throw staleConflict(executorId, expectedGeneration);
      }
      this.#db
        .query(
          "DELETE FROM managed_executors WHERE executor_id = ? AND instance_generation = ?",
        )
        .run(executorId, expectedGeneration);
    });
    remove.immediate();
  }

  /** Atomically proves lifecycle connectability and claims one same-generation instance. */
  async claimConnectableInstance(input: {
    executorId: string;
    generation: number;
    instanceId: string;
  }): Promise<boolean> {
    assertIdentity(input.executorId, "executorId");
    assertGeneration(input.generation, "generation");
    assertIdentity(input.instanceId, "instanceId");
    const claim = this.#db.transaction(() => {
      const record = this.#db
        .query<{ instance_generation: number; lifecycle: string }, [string]>(
          "SELECT instance_generation, lifecycle FROM managed_executors WHERE executor_id = ?",
        )
        .get(input.executorId);
      if (
        !record ||
        record.instance_generation !== input.generation ||
        record.lifecycle !== "awake"
      )
        return false;
      const existing = this.#db
        .query<{ instance_id: string }, [string, number]>(
          "SELECT instance_id FROM managed_executor_instance_claims WHERE executor_id = ? AND generation = ?",
        )
        .get(input.executorId, input.generation);
      if (existing) return existing.instance_id === input.instanceId;
      this.#db
        .query(
          "INSERT INTO managed_executor_instance_claims (executor_id, generation, instance_id) VALUES (?, ?, ?)",
        )
        .run(input.executorId, input.generation, input.instanceId);
      return true;
    });
    return claim.immediate();
  }

  async appendAudit(entry: ExecutorAuditEntry): Promise<void> {
    assertAuditEntry(entry);
    const append = this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO managed_executor_force_destroy_audit
            (executor_id, generation, action, operator_id, reason, at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.executorId,
          entry.generation,
          entry.action,
          entry.operatorId,
          entry.reason,
          entry.atMs,
        );
    });
    append.immediate();
  }

  /** Reads force-destroy audit entries in durable append order. */
  async auditEntries(
    executorId?: string,
  ): Promise<readonly ExecutorAuditEntry[]> {
    if (executorId !== undefined) assertIdentity(executorId, "executorId");
    const rows =
      executorId === undefined
        ? this.#db
            .query<AuditRow, []>(
              `SELECT executor_id, generation, action, operator_id, reason, at_ms
             FROM managed_executor_force_destroy_audit ORDER BY id`,
            )
            .all()
        : this.#db
            .query<AuditRow, [string]>(
              `SELECT executor_id, generation, action, operator_id, reason, at_ms
             FROM managed_executor_force_destroy_audit
             WHERE executor_id = ? ORDER BY id`,
            )
            .all(executorId);
    return rows.map(decodeAuditEntry);
  }

  #getRawByExecutor(executorId: string): ExecutorRow | null {
    return this.#db
      .query<ExecutorRow, [string]>(
        `SELECT ${RECORD_COLUMNS} FROM managed_executors WHERE executor_id = ?`,
      )
      .get(executorId);
  }

  #hasExecutor(executorId: string): boolean {
    return (
      this.#db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM managed_executors WHERE executor_id = ?",
        )
        .get(executorId) !== null
    );
  }

  #hasSession(sessionId: string): boolean {
    return (
      this.#db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM managed_executors WHERE session_id = ?",
        )
        .get(sessionId) !== null
    );
  }

  #insertRecord(record: ExecutorRecord): void {
    this.#db
      .query(
        `INSERT INTO managed_executors (${RECORD_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...recordValues(record));
  }
}

function recordValues(record: ExecutorRecord): (string | number | null)[] {
  return [
    record.executorId,
    record.sessionId,
    record.provider,
    record.resourceId ?? null,
    record.workspaceId ?? null,
    record.resourceGeneration ?? null,
    record.instanceGeneration,
    record.lifecycle,
    record.project.revision,
    record.project.baseCommit,
    record.project.durableDelta,
    record.createdAtMs,
    record.updatedAtMs,
    record.error ?? null,
  ];
}

function recordValuesForUpdate(
  record: ExecutorRecord,
): (string | number | null)[] {
  const values = recordValues(record);
  return values.slice(2);
}

function decodeRecord(row: ExecutorRow): ExecutorRecord {
  const executorId = decodeIdentity(row.executor_id, "executor_id");
  const sessionId = decodeIdentity(row.session_id, "session_id");
  const provider = decodeEnum(
    row.provider,
    EXECUTOR_PROVIDER_IDS,
    "provider",
  ) as ExecutorProviderId;
  const lifecycle = decodeEnum(row.lifecycle, LIFECYCLES, "lifecycle");
  const resourceId = decodeOptionalIdentity(row.resource_id, "resource_id");
  const workspaceId = decodeOptionalIdentity(row.workspace_id, "workspace_id");
  const resourceGeneration = decodeOptionalGeneration(
    row.resource_generation,
    "resource_generation",
  );
  const instanceGeneration = decodeGeneration(
    row.instance_generation,
    "instance_generation",
  );
  const revision = decodeString(row.project_revision, "project_revision");
  const baseCommit = decodeString(
    row.project_base_commit,
    "project_base_commit",
  );
  const durableDelta = decodeString(
    row.project_durable_delta,
    "project_durable_delta",
  );
  const createdAtMs = decodeTimestamp(row.created_at_ms, "created_at_ms");
  const updatedAtMs = decodeTimestamp(row.updated_at_ms, "updated_at_ms");
  const error = decodeOptionalString(row.error, "error");

  const record: ExecutorRecord = {
    executorId,
    sessionId,
    provider,
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(resourceGeneration === undefined ? {} : { resourceGeneration }),
    instanceGeneration,
    lifecycle,
    project: { revision, baseCommit, durableDelta },
    createdAtMs,
    updatedAtMs,
    ...(error === undefined ? {} : { error }),
  };
  assertRecordRelationships(record);
  return record;
}

function decodeAuditEntry(row: AuditRow): ExecutorAuditEntry {
  const action = decodeEnum(row.action, ["force_destroy"] as const, "action");
  return {
    executorId: decodeIdentity(row.executor_id, "executor_id"),
    generation: decodeGeneration(row.generation, "generation"),
    action,
    operatorId: decodeIdentity(row.operator_id, "operator_id"),
    reason: decodeString(row.reason, "reason"),
    atMs: decodeTimestamp(row.at_ms, "at_ms"),
  };
}

function assertRecord(record: ExecutorRecord): void {
  if (!record || typeof record !== "object") throw corrupt("record");
  assertIdentity(record.executorId, "executorId");
  assertIdentity(record.sessionId, "sessionId");
  decodeEnum(record.provider, EXECUTOR_PROVIDER_IDS, "provider");
  decodeEnum(record.lifecycle, LIFECYCLES, "lifecycle");
  decodeOptionalIdentity(record.resourceId ?? null, "resourceId");
  decodeOptionalIdentity(record.workspaceId ?? null, "workspaceId");
  decodeOptionalGeneration(
    record.resourceGeneration ?? null,
    "resourceGeneration",
  );
  assertGeneration(record.instanceGeneration, "instanceGeneration");
  if (!record.project || typeof record.project !== "object")
    throw corrupt("project");
  decodeString(record.project.revision, "project.revision");
  decodeString(record.project.baseCommit, "project.baseCommit");
  decodeString(record.project.durableDelta, "project.durableDelta");
  decodeTimestamp(record.createdAtMs, "createdAtMs");
  decodeTimestamp(record.updatedAtMs, "updatedAtMs");
  decodeOptionalString(record.error ?? null, "error");
  assertRecordRelationships(record);
}

function assertRecordRelationships(record: ExecutorRecord): void {
  const resourceFields = [
    record.resourceId,
    record.workspaceId,
    record.resourceGeneration,
  ];
  const present = resourceFields.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== resourceFields.length) {
    throw corrupt("provider resource identity must be complete");
  }
  if (
    record.resourceGeneration !== undefined &&
    record.resourceGeneration > record.instanceGeneration
  ) {
    throw corrupt("resourceGeneration exceeds instanceGeneration");
  }
  if (
    (record.lifecycle === "awake" ||
      record.lifecycle === "sleeping" ||
      record.lifecycle === "waking") &&
    present === 0
  ) {
    throw corrupt(`${record.lifecycle} Executor has no provider resource`);
  }
  if (record.updatedAtMs < record.createdAtMs) {
    throw corrupt("updatedAtMs precedes createdAtMs");
  }
}

function assertAuditEntry(entry: ExecutorAuditEntry): void {
  if (!entry || typeof entry !== "object") throw corrupt("audit entry");
  assertIdentity(entry.executorId, "executorId");
  assertGeneration(entry.generation, "generation");
  decodeEnum(entry.action, ["force_destroy"] as const, "action");
  assertIdentity(entry.operatorId, "operatorId");
  decodeString(entry.reason, "reason");
  decodeTimestamp(entry.atMs, "atMs");
}

function assertIdentity(
  value: unknown,
  field: string,
): asserts value is string {
  decodeIdentity(value, field);
}

function decodeIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw corrupt(field);
  }
  return value;
}

function decodeOptionalIdentity(
  value: unknown,
  field: string,
): string | undefined {
  return value === null || value === undefined
    ? undefined
    : decodeIdentity(value, field);
}

function assertGeneration(
  value: unknown,
  field: string,
): asserts value is number {
  decodeGeneration(value, field);
}

function decodeGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw corrupt(field);
  return value as number;
}

function decodeOptionalGeneration(
  value: unknown,
  field: string,
): number | undefined {
  return value === null || value === undefined
    ? undefined
    : decodeGeneration(value, field);
}

function decodeTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw corrupt(field);
  return value as number;
}

function decodeString(value: unknown, field: string): string {
  if (typeof value !== "string") throw corrupt(field);
  return value;
}

function decodeOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return decodeString(value, field);
}

function decodeEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value))
    throw corrupt(field);
  return value as T[number];
}

function corrupt(field: string): TypeError {
  return new TypeError(`Malformed managed Executor state: ${field}`);
}

function initializeSchema(db: Database): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
    throw new Error(`unsupported managed Executor schema version: ${version}`);
  }

  if (version === 0) {
    const existing = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('managed_executors', 'managed_executor_force_destroy_audit')
         LIMIT 1`,
      )
      .get();
    if (existing) {
      throw new Error("unversioned managed Executor schema is not supported");
    }
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`
        CREATE TABLE managed_executors (
          executor_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL CHECK(provider IN ('box', 'daytona', 'modal')),
          resource_id TEXT,
          workspace_id TEXT,
          resource_generation INTEGER,
          instance_generation INTEGER NOT NULL CHECK(instance_generation >= 1),
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('preparing', 'awake', 'sleeping', 'waking', 'needs_attention')),
          project_revision TEXT NOT NULL,
          project_base_commit TEXT NOT NULL,
          project_durable_delta TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          error TEXT
        );
        CREATE TABLE managed_executor_force_destroy_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          executor_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          action TEXT NOT NULL CHECK(action = 'force_destroy'),
          operator_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          at_ms INTEGER NOT NULL
        );
        CREATE INDEX managed_executor_audit_executor_idx
          ON managed_executor_force_destroy_audit(executor_id, id);
        CREATE TABLE managed_executor_instance_claims (
          executor_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          instance_id TEXT NOT NULL,
          PRIMARY KEY(executor_id, generation),
          FOREIGN KEY(executor_id) REFERENCES managed_executors(executor_id) ON DELETE CASCADE
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  if (version === 1) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`
        CREATE TABLE managed_executor_instance_claims (
          executor_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          instance_id TEXT NOT NULL,
          PRIMARY KEY(executor_id, generation),
          FOREIGN KEY(executor_id) REFERENCES managed_executors(executor_id) ON DELETE CASCADE
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  assertTableColumns(db, "managed_executors", RECORD_COLUMN_NAMES);
  assertTableColumns(
    db,
    "managed_executor_force_destroy_audit",
    AUDIT_COLUMN_NAMES,
  );
  assertTableColumns(db, "managed_executor_instance_claims", [
    "executor_id",
    "generation",
    "instance_id",
  ]);
}

function assertTableColumns(
  db: Database,
  table: string,
  expected: readonly string[],
): void {
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map((column) => column.name);
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column !== expected[index])
  ) {
    throw new Error(`managed Executor schema mismatch: ${table}`);
  }
}

function preparePrivateDatabasePath(dbPath: string): void {
  const absolutePath = resolve(dbPath);
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const root = parse(parent).root;
  let current = root;
  for (const part of parent
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `unsafe managed Executor state path component: ${current}`,
      );
    }
  }
  chmodSync(parent, 0o700);

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(
    absolutePath,
    constants.O_CREAT | constants.O_RDWR | noFollow,
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("managed Executor state path is not a regular file");
    }
    chmodSync(absolutePath, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function preflightSidecars(dbPath: string): void {
  for (const path of [`${resolve(dbPath)}-wal`, `${resolve(dbPath)}-shm`]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe managed Executor SQLite file: ${path}`);
    const descriptor = openSync(
      path,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`unsafe managed Executor SQLite file: ${path}`);
    } finally {
      closeSync(descriptor);
    }
  }
}

function secureSqliteFiles(dbPath: string): void {
  for (const path of [
    resolve(dbPath),
    `${resolve(dbPath)}-wal`,
    `${resolve(dbPath)}-shm`,
  ]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`unsafe managed Executor SQLite file: ${path}`);
    }
    chmodSync(path, 0o600);
  }
}

function staleConflict(
  executorId: string,
  expectedGeneration: number,
): ExecutorStateConflictError {
  return new ExecutorStateConflictError(
    `Executor ${executorId} generation is stale (expected ${expectedGeneration})`,
  );
}
