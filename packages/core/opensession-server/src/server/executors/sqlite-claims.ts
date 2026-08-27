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

const SCHEMA_VERSION = 2;

/** Durable Runner incarnation claims and monotonic generation revocations. */
export class SqliteRunnerExecutorClaims {
  readonly #db: Database;
  #closed = false;

  constructor(dbPath: string) {
    if (!dbPath || dbPath === ":memory:")
      throw new Error(
        "a filesystem database path is required for Runner Executor claims",
      );
    const path = resolve(dbPath);
    preparePrivatePath(path);
    preflightSidecars(path);
    const db = new Database(path, { create: true, strict: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      initialize(db);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      secureFiles(path);
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Atomically claims one instance and refuses generations below the durable high-water mark. */
  claim(input: {
    executorId: string;
    generation: number;
    instanceId: string;
  }): boolean {
    this.#assertOpen();
    assertIdentity(input.executorId, "executorId");
    assertIdentity(input.instanceId, "instanceId");
    assertGeneration(input.generation);
    const transaction = this.#db.transaction(() => {
      const authority = this.#db
        .query<
          { highest_generation: number; revoked_through: number },
          [string]
        >(
          "SELECT highest_generation, revoked_through FROM runner_executor_authority WHERE executor_id = ?",
        )
        .get(input.executorId);
      if (
        authority &&
        (input.generation < authority.highest_generation ||
          input.generation <= authority.revoked_through)
      )
        return false;
      if (!authority) {
        this.#db
          .query(
            "INSERT INTO runner_executor_authority (executor_id, highest_generation, revoked_through) VALUES (?, ?, 0)",
          )
          .run(input.executorId, input.generation);
      } else if (input.generation > authority.highest_generation) {
        this.#db
          .query(
            "UPDATE runner_executor_authority SET highest_generation = ? WHERE executor_id = ?",
          )
          .run(input.generation, input.executorId);
      }
      const existing = this.#db
        .query<{ instance_id: string }, [string, number]>(
          "SELECT instance_id FROM runner_executor_instance_claims WHERE executor_id = ? AND generation = ?",
        )
        .get(input.executorId, input.generation);
      if (existing) return existing.instance_id === input.instanceId;
      this.#db
        .query(
          "INSERT INTO runner_executor_instance_claims (executor_id, generation, instance_id) VALUES (?, ?, ?)",
        )
        .run(input.executorId, input.generation, input.instanceId);
      return true;
    });
    return transaction.immediate();
  }

  revokeThrough(executorId: string, generation: number): void {
    this.#assertOpen();
    assertIdentity(executorId, "executorId");
    assertGeneration(generation);
    const transaction = this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO runner_executor_authority (executor_id, highest_generation, revoked_through)
           VALUES (?, ?, ?)
           ON CONFLICT(executor_id) DO UPDATE SET
             highest_generation = MAX(highest_generation, excluded.highest_generation),
             revoked_through = MAX(revoked_through, excluded.revoked_through)`,
        )
        .run(executorId, generation, generation);
      this.#db
        .query(
          "DELETE FROM runner_executor_instance_claims WHERE executor_id = ? AND generation <= ?",
        )
        .run(executorId, generation);
    });
    transaction.immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error("Runner Executor claims database is closed");
  }
}

function initialize(db: Database): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  // The Executor runtime has never been boot-wired, so no production claims DB
  // can be version 1. Refuse that disposable pre-production shape explicitly.
  if (version === 1)
    throw new Error(
      "Runner Executor claims schema version 1 is disposable pre-production state; delete the claims database and restart",
    );
  if (version !== 0 && version !== SCHEMA_VERSION)
    throw new Error(`unsupported Runner Executor claims schema: ${version}`);
  if (version === 0) {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (tables.length)
      throw new Error(
        "unversioned Runner Executor claims schema is unsupported",
      );
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`
        CREATE TABLE runner_executor_authority (
          executor_id TEXT PRIMARY KEY NOT NULL,
          highest_generation INTEGER NOT NULL CHECK(highest_generation >= 1),
          revoked_through INTEGER NOT NULL CHECK(revoked_through >= 0)
        ) STRICT;
        CREATE TABLE runner_executor_instance_claims (
          executor_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          instance_id TEXT NOT NULL,
          PRIMARY KEY(executor_id, generation),
          FOREIGN KEY(executor_id) REFERENCES runner_executor_authority(executor_id) ON DELETE CASCADE
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  if (
    tables.join("\0") !==
    "runner_executor_authority\0runner_executor_instance_claims"
  )
    throw new Error("Runner Executor claims schema tables do not match");
  assertColumns(db, "runner_executor_authority", [
    "executor_id",
    "highest_generation",
    "revoked_through",
  ]);
  assertColumns(db, "runner_executor_instance_claims", [
    "executor_id",
    "generation",
    "instance_id",
  ]);
}

function assertColumns(
  db: Database,
  table: string,
  expected: readonly string[],
): void {
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map(({ name }) => name);
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column !== expected[index])
  )
    throw new Error(
      `Runner Executor claims schema columns do not match: ${table}`,
    );
}

function assertIdentity(value: string, name: string): void {
  if (
    !value ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError(`invalid ${name}`);
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("invalid generation");
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
        `unsafe Runner Executor claims path component: ${current}`,
      );
  }
  chmodSync(parent, 0o700);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error("Runner Executor claims path is not a regular file");
    chmodSync(path, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

function preflightSidecars(path: string): void {
  for (const file of [`${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe Runner Executor claims SQLite file: ${file}`);
    const descriptor = openSync(
      file,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!fstatSync(descriptor).isFile())
        throw new Error(`unsafe Runner Executor claims SQLite file: ${file}`);
    } finally {
      closeSync(descriptor);
    }
  }
}

function secureFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe Runner Executor claims SQLite file: ${file}`);
    chmodSync(file, 0o600);
  }
}
