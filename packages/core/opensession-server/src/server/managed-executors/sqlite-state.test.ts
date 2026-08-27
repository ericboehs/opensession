import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanModuleSideEffects } from "../../../../../../scripts/check-module-side-effects";
import { ExecutorStateConflictError, type ExecutorRecord } from "./state";
import { SqliteExecutorStateStore } from "./sqlite-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "executor-state-"));
  roots.push(root);
  return join(root, "private", "state.sqlite");
}

function record(overrides: Partial<ExecutorRecord> = {}): ExecutorRecord {
  return {
    executorId: "executor-1",
    sessionId: "session-1",
    provider: "box",
    instanceGeneration: 1,
    lifecycle: "preparing",
    project: {
      revision: "revision-1",
      baseCommit: "abc123",
      durableDelta: "delta-1",
    },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe("SqliteExecutorStateStore", () => {
  test("persists complete records across reopen", async () => {
    const path = databasePath();
    const expected = record({
      resourceId: "resource-1",
      workspaceId: "workspace-1",
      resourceGeneration: 7,
      instanceGeneration: 9,
      lifecycle: "needs_attention",
      error: "provider unavailable",
    });
    const first = new SqliteExecutorStateStore(path);
    await first.insertIntent(expected);
    first.close();

    const reopened = new SqliteExecutorStateStore(path);
    expect(await reopened.getByExecutorId(expected.executorId)).toEqual(
      expected,
    );
    expect(await reopened.getBySessionId(expected.sessionId)).toEqual(expected);
    reopened.close();
  });

  test("enforces unique Executor and session identities across store instances", async () => {
    const path = databasePath();
    const first = new SqliteExecutorStateStore(path);
    const second = new SqliteExecutorStateStore(path);
    await first.insertIntent(record());

    await expect(
      second.insertIntent(record({ sessionId: "session-2" })),
    ).rejects.toBeInstanceOf(ExecutorStateConflictError);
    await expect(
      second.insertIntent(record({ executorId: "executor-2" })),
    ).rejects.toThrow("already has a managed Executor");
    first.close();
    second.close();
  });

  test("atomically claims one instance only while the generation is connectable", async () => {
    const store = new SqliteExecutorStateStore(databasePath());
    const awake = record({
      resourceId: "resource-1",
      workspaceId: "workspace-1",
      resourceGeneration: 1,
      lifecycle: "awake",
    });
    await store.insertIntent(awake);
    expect(
      await store.claimConnectableInstance({
        executorId: "executor-1",
        generation: 1,
        instanceId: "instance-1",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectableInstance({
        executorId: "executor-1",
        generation: 1,
        instanceId: "instance-2",
      }),
    ).toBe(false);
    await store.compareAndSwap("executor-1", 1, {
      ...awake,
      instanceGeneration: 2,
      lifecycle: "preparing",
      updatedAtMs: 2_000,
    });
    expect(
      await store.claimConnectableInstance({
        executorId: "executor-1",
        generation: 1,
        instanceId: "instance-1",
      }),
    ).toBe(false);
    expect(
      await store.claimConnectableInstance({
        executorId: "executor-1",
        generation: 2,
        instanceId: "instance-2",
      }),
    ).toBe(false);
    store.close();
  });

  test("distinguishes stale and missing CAS and delete conflicts", async () => {
    const store = new SqliteExecutorStateStore(databasePath());
    await store.insertIntent(record());

    await expect(
      store.compareAndSwap("executor-1", 2, record({ instanceGeneration: 3 })),
    ).rejects.toThrow("generation is stale");
    await expect(
      store.compareAndSwap("missing", 1, record({ executorId: "missing" })),
    ).rejects.toThrow("does not exist");
    await expect(store.delete("executor-1", 2)).rejects.toThrow(
      "generation is stale",
    );
    await expect(store.delete("missing", 1)).rejects.toThrow("does not exist");
    store.close();
  });

  test("rolls back failed mutations without changing the prior record", async () => {
    const store = new SqliteExecutorStateStore(databasePath());
    const original = record();
    await store.insertIntent(original);

    await expect(
      store.compareAndSwap(
        "executor-1",
        1,
        record({ sessionId: "changed-session", instanceGeneration: 2 }),
      ),
    ).rejects.toThrow("identity are immutable");
    expect(await store.getByExecutorId("executor-1")).toEqual(original);
    expect(await store.getBySessionId("changed-session")).toBeUndefined();
    store.close();
  });

  test("persists force-destroy audit entries independently of record deletion", async () => {
    const path = databasePath();
    const store = new SqliteExecutorStateStore(path);
    await store.insertIntent(record());
    await store.appendAudit({
      executorId: "executor-1",
      generation: 1,
      action: "force_destroy",
      operatorId: "operator-1",
      reason: "orphaned provider resource",
      atMs: 2_000,
    });
    await store.delete("executor-1", 1);
    store.close();

    const reopened = new SqliteExecutorStateStore(path);
    expect(await reopened.auditEntries("executor-1")).toEqual([
      {
        executorId: "executor-1",
        generation: 1,
        action: "force_destroy",
        operatorId: "operator-1",
        reason: "orphaned provider resource",
        atMs: 2_000,
      },
    ]);
    reopened.close();
  });

  test("keeps resource generation independent without exceeding the authority fence", async () => {
    const store = new SqliteExecutorStateStore(databasePath());
    const attached = record({
      resourceId: "resource-1",
      workspaceId: "workspace-1",
      resourceGeneration: 1,
    });
    await store.insertIntent(attached);
    const next = {
      ...attached,
      instanceGeneration: 2,
      updatedAtMs: 2_000,
    };
    await store.compareAndSwap("executor-1", 1, next);
    expect(await store.getByExecutorId("executor-1")).toEqual(next);

    await expect(
      store.compareAndSwap("executor-1", 2, {
        ...next,
        resourceGeneration: 4,
        instanceGeneration: 3,
        updatedAtMs: 3_000,
      }),
    ).rejects.toThrow("resourceGeneration exceeds instanceGeneration");

    const withoutResourceIdentity = record({
      instanceGeneration: 3,
      updatedAtMs: 3_000,
    });
    await store.compareAndSwap("executor-1", 2, withoutResourceIdentity);
    expect(await store.getByExecutorId("executor-1")).toEqual(
      withoutResourceIdentity,
    );
    store.close();
  });

  test("fails closed when persisted fields are malformed", async () => {
    const corruptions: Array<[string, string | number | Uint8Array]> = [
      ["provider", "unknown"],
      ["lifecycle", "destroyed"],
      ["resource_generation", 0],
      ["instance_generation", 0],
      ["executor_id", " bad"],
      ["project_revision", new Uint8Array([1, 2])],
    ];

    for (const [column, value] of corruptions) {
      const path = databasePath();
      const store = new SqliteExecutorStateStore(path);
      await store.insertIntent(record());
      store.close();
      const raw = new Database(path);
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw.query(`UPDATE managed_executors SET ${column} = ?`).run(value);
      raw.close();

      const reopened = new SqliteExecutorStateStore(path);
      await expect(reopened.getBySessionId("session-1")).rejects.toThrow(
        "Malformed managed Executor state",
      );
      reopened.close();
    }
  });

  test("rejects partial resource identities and backward chronology", async () => {
    const store = new SqliteExecutorStateStore(databasePath());
    await expect(
      store.insertIntent(record({ resourceGeneration: 1 })),
    ).rejects.toThrow("provider resource identity must be complete");
    await expect(
      store.insertIntent(record({ updatedAtMs: 999 })),
    ).rejects.toThrow("updatedAtMs precedes createdAtMs");
    store.close();
  });

  test("creates private files and rejects a symlink database path", () => {
    const path = databasePath();
    const store = new SqliteExecutorStateStore(path);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
    store.close();

    const link = `${path}.link`;
    symlinkSync(path, link);
    expect(() => new SqliteExecutorStateStore(link)).toThrow();

    const sidecarPath = databasePath();
    mkdirSync(dirname(sidecarPath), { recursive: true });
    const target = `${sidecarPath}.target`;
    writeFileSync(target, "target");
    symlinkSync(target, `${sidecarPath}-wal`);
    expect(() => new SqliteExecutorStateStore(sidecarPath)).toThrow(
      "unsafe managed Executor SQLite file",
    );
  });

  test("migrates version 1 state with durable instance claims", async () => {
    const path = databasePath();
    new SqliteExecutorStateStore(path).close();
    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE managed_executor_instance_claims;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new SqliteExecutorStateStore(path);
    await migrated.insertIntent(
      record({
        resourceId: "resource-1",
        workspaceId: "workspace-1",
        resourceGeneration: 1,
        lifecycle: "awake",
      }),
    );
    expect(
      await migrated.claimConnectableInstance({
        executorId: "executor-1",
        generation: 1,
        instanceId: "instance-1",
      }),
    ).toBe(true);
    migrated.close();
  });

  test("rejects unknown and unversioned schemas", () => {
    const newerPath = databasePath();
    new SqliteExecutorStateStore(newerPath).close();
    const newer = new Database(newerPath);
    newer.exec("PRAGMA user_version = 3");
    newer.close();
    expect(() => new SqliteExecutorStateStore(newerPath)).toThrow(
      "unsupported managed Executor schema version",
    );

    const legacyPath = databasePath();
    new SqliteExecutorStateStore(legacyPath).close();
    const legacy = new Database(legacyPath);
    legacy.exec(`
      DROP TABLE managed_executors;
      DROP TABLE managed_executor_force_destroy_audit;
      PRAGMA user_version = 0;
      CREATE TABLE managed_executors (executor_id TEXT);
    `);
    legacy.close();
    expect(() => new SqliteExecutorStateStore(legacyPath)).toThrow(
      "unversioned managed Executor schema",
    );
  });

  test("supports concurrent durable writes from separate connections", async () => {
    const path = databasePath();
    const first = new SqliteExecutorStateStore(path);
    const second = new SqliteExecutorStateStore(path);
    await Promise.all([
      first.insertIntent(record()),
      second.insertIntent(
        record({ executorId: "executor-2", sessionId: "session-2" }),
      ),
    ]);
    expect(await first.getBySessionId("session-2")).toEqual(
      record({ executorId: "executor-2", sessionId: "session-2" }),
    );
    first.close();
    second.close();
  });
});

test("SQLite Executor state module is import-inert", async () => {
  const module =
    "packages/core/opensession-server/src/server/managed-executors/sqlite-state.ts";
  const before = readFileSync(module, "utf8");
  const scan = await scanModuleSideEffects([module]);
  expect(scan.failed).toEqual([]);
  expect(scan.hits).toEqual([]);
  expect(readFileSync(module, "utf8")).toBe(before);
});
