import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LedgerFullError,
  operationDigest,
  type LedgerCommandIdentity,
  type LedgerScope,
} from "./ledger";
import {
  openSQLiteCommandLedger,
  type SQLiteCommandLedger,
} from "./sqlite-ledger";

const roots: string[] = [];
const ledgers: SQLiteCommandLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function pathFor(): string {
  const root = mkdtempSync(join(tmpdir(), "sqlite-ledger-"));
  roots.push(root);
  return join(root, "private", "ledger.sqlite");
}
function open(dbPath = pathFor(), options: Record<string, number> = {}) {
  const ledger = openSQLiteCommandLedger({ dbPath, ...options });
  ledgers.push(ledger);
  return ledger;
}
function close(ledger: SQLiteCommandLedger) {
  ledger.close();
  ledgers.splice(ledgers.indexOf(ledger), 1);
}
const baseScope: LedgerScope = {
  executorId: "executor-1",
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 1,
};
function command(
  requestId: string,
  options: { key?: string; scope?: Partial<LedgerScope>; data?: string } = {},
): LedgerCommandIdentity {
  const operation = options.key
    ? {
        kind: "fs.write" as const,
        path: "x",
        data: options.data ?? "a",
        encoding: "utf8" as const,
        idempotencyKey: options.key,
      }
    : ({ kind: "fs.read" as const, path: "x" } as const);
  return {
    ...baseScope,
    ...options.scope,
    requestId,
    ...(options.key ? { idempotencyKey: options.key } : {}),
    operation,
    operationDigest: operationDigest(operation),
  };
}
function receipt(identity: LedgerCommandIdentity, id: string) {
  return {
    receiptId: id,
    requestId: identity.requestId,
    state: "queued" as const,
    acceptedAt: "2026-08-22T12:00:00.000Z",
    ...(identity.idempotencyKey
      ? { idempotencyKey: identity.idempotencyKey }
      : {}),
  };
}
async function claim(
  ledger: SQLiteCommandLedger,
  identity: LedgerCommandIdentity,
  id: string,
) {
  return ledger.claim(identity, receipt(identity, id));
}
async function running(
  ledger: SQLiteCommandLedger,
  identity: LedgerCommandIdentity,
  id: string,
) {
  await claim(ledger, identity, id);
  return ledger.transition(identity, id, "queued", { state: "running" });
}

const completedAt = "2026-08-22T12:00:01.000Z";

describe("SQLiteCommandLedger", () => {
  test("atomically returns one stable mutation receipt and detects digest conflicts", async () => {
    const dbPath = pathFor();
    const a = open(dbPath);
    const b = open(dbPath);
    const left = command("request-a", { key: "shared" });
    const right = command("request-b", { key: "shared" });
    const results = await Promise.all([
      claim(a, left, "receipt-a"),
      claim(b, right, "receipt-b"),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results[0]!.record.receipt.receiptId).toBe(
      results[1]!.record.receipt.receiptId,
    );
    await expect(
      claim(
        a,
        command("request-c", { key: "shared", data: "different" }),
        "receipt-c",
      ),
    ).rejects.toMatchObject({ name: "LedgerConflictError" });
  });

  test("scopes key reuse by executor/root/run/generation and reads by request", async () => {
    const ledger = open();
    const variants = [
      command("a", { key: "same" }),
      command("b", { key: "same", scope: { rootId: "root-2" } }),
      command("c", { key: "same", scope: { runId: "run-2" } }),
      command("d", { key: "same", scope: { generation: 2 } }),
    ];
    for (const [index, identity] of variants.entries())
      expect((await claim(ledger, identity, `r${index}`)).claimed).toBe(true);
    expect((await claim(ledger, command("read-1"), "read-r1")).claimed).toBe(
      true,
    );
    expect((await claim(ledger, command("read-2"), "read-r2")).claimed).toBe(
      true,
    );
  });

  test("requires exact scope ownership for receipt lookup", async () => {
    const ledger = open();
    const identity = command("request");
    await claim(ledger, identity, "receipt");
    expect(await ledger.get(identity, "receipt")).toBeDefined();
    expect(
      await ledger.get({ ...identity, rootId: "other-root" }, "receipt"),
    ).toBeUndefined();
  });

  test("recovers queued and running work without replay and marks mutations ambiguous", async () => {
    const ledger = open();
    const read = command("read");
    const mutation = command("mutation", { key: "key" });
    await claim(ledger, read, "read-r");
    await running(ledger, mutation, "mutation-r");
    expect(await ledger.recover()).toBe(2);
    const recoveredRead = await ledger.get(read, "read-r");
    expect(recoveredRead).toMatchObject({
      receipt: { state: "failed" },
      error: { code: "operation_failed" },
    });
    expect(recoveredRead?.error?.ambiguous).toBeUndefined();
    expect(await ledger.get(mutation, "mutation-r")).toMatchObject({
      receipt: { state: "failed" },
      error: { ambiguous: true },
    });
    expect(await ledger.recover()).toBe(0);
  });

  test("enforces monotonic CAS transitions and coherent terminal payloads", async () => {
    const ledger = open();
    const identity = command("request");
    await running(ledger, identity, "receipt");
    const succeeded = await ledger.transition(identity, "receipt", "running", {
      state: "succeeded",
      completedAt,
      outcome: { kind: "fs.read", streamId: "stream", size: 0, binary: false },
    });
    expect(succeeded.error).toBeUndefined();
    await expect(
      ledger.transition(identity, "receipt", "running", {
        state: "failed",
        completedAt,
        error: { code: "operation_failed", message: "late send failure" },
      }),
    ).rejects.toMatchObject({ name: "LedgerTransitionError" });
    expect((await ledger.get(identity, "receipt"))?.receipt.state).toBe(
      "succeeded",
    );
  });

  test("failed transitions contain no stale outcome or events", async () => {
    const ledger = open();
    const identity = command("request");
    await running(ledger, identity, "receipt");
    const failed = await ledger.transition(identity, "receipt", "running", {
      state: "failed",
      completedAt,
      error: { code: "operation_failed", message: "failed" },
    });
    expect(failed).toMatchObject({ receipt: { state: "failed" } });
    expect(failed.outcome).toBeUndefined();
    expect(failed.events).toBeUndefined();
  });

  test("reclaims oldest terminal reads but never mutations or active rows", async () => {
    const ledger = open(undefined, { capacity: 2 });
    const oldRead = command("old-read");
    await running(ledger, oldRead, "old-r");
    await ledger.transition(oldRead, "old-r", "running", {
      state: "succeeded",
      completedAt,
      outcome: { kind: "fs.read", streamId: "stream", size: 0, binary: false },
    });
    const mutation = command("mutation", { key: "key" });
    await claim(ledger, mutation, "mutation-r");
    const nextRead = command("next-read");
    await claim(ledger, nextRead, "next-r");
    expect(await ledger.get(oldRead, "old-r")).toBeUndefined();
    expect(await ledger.get(mutation, "mutation-r")).toBeDefined();
    await expect(
      claim(ledger, command("last-read"), "last-r"),
    ).rejects.toBeInstanceOf(LedgerFullError);
  });

  test("retires only acknowledged terminal scopes and restores capacity", async () => {
    const ledger = open(undefined, { capacity: 2 });
    const retired = command("retired", { key: "retired-key" });
    await running(ledger, retired, "retired-receipt");
    await ledger.transition(retired, "retired-receipt", "running", {
      state: "succeeded",
      completedAt,
      outcome: { kind: "fs.changed", path: "x" },
    });
    const active = command("active", {
      key: "active-key",
      scope: { runId: "active-run" },
    });
    await claim(ledger, active, "active-receipt");
    await expect(ledger.retireScope(active)).rejects.toMatchObject({
      name: "LedgerScopeActiveError",
    });
    await expect(
      claim(
        ledger,
        command("blocked", {
          key: "blocked-key",
          scope: { runId: "blocked-run" },
        }),
        "blocked-receipt",
      ),
    ).rejects.toBeInstanceOf(LedgerFullError);
    expect(await ledger.retireScope(retired)).toBe(1);
    expect(
      (
        await claim(
          ledger,
          command("restored", {
            key: "restored-key",
            scope: { runId: "restored-run" },
          }),
          "restored-receipt",
        )
      ).claimed,
    ).toBe(true);
    expect(await ledger.get(active, "active-receipt")).toBeDefined();
  });

  test("persists compact retired-scope replay tombstones until permanent purge", async () => {
    const dbPath = pathFor();
    const identity = command("retire-me", { key: "retire-key" });
    const first = open(dbPath);
    await running(first, identity, "retire-receipt");
    await first.transition(identity, "retire-receipt", "running", {
      state: "succeeded",
      completedAt,
      outcome: { kind: "fs.changed", path: "x" },
    });
    await first.retireScope(identity);
    close(first);

    const reopened = open(dbPath);
    await expect(
      claim(
        reopened,
        command("replay", { key: "retire-key" }),
        "replay-receipt",
      ),
    ).rejects.toMatchObject({ name: "LedgerScopeRetiredError" });
    expect(await reopened.purgeRetiredScope(identity)).toBe(true);
    expect(
      (
        await claim(
          reopened,
          command("after-horizon", { key: "retire-key" }),
          "after-horizon-receipt",
        )
      ).claimed,
    ).toBe(true);
  });

  test("rejects semantically incompatible outcomes", async () => {
    const ledger = open();
    const identity = command("write", { key: "write-key" });
    await running(ledger, identity, "receipt");
    await expect(
      ledger.transition(identity, "receipt", "running", {
        state: "succeeded",
        completedAt,
        outcome: { kind: "fs.changed", path: "wrong-target" },
      }),
    ).rejects.toThrow("incompatible");
    expect((await ledger.get(identity, "receipt"))?.receipt.state).toBe(
      "running",
    );
  });

  test("accepts a contiguous stream batch starting after sequence zero", async () => {
    const ledger = open();
    const operation = { kind: "process.status" as const, processId: "process" };
    const identity: LedgerCommandIdentity = {
      ...baseScope,
      requestId: "process-status",
      operation,
      operationDigest: operationDigest(operation),
    };
    await running(ledger, identity, "process-receipt");
    const result = await ledger.transition(
      identity,
      "process-receipt",
      "running",
      {
        state: "succeeded",
        completedAt,
        outcome: {
          kind: "process",
          processId: "process",
          state: "running",
          streamId: "process-stream",
        },
        events: [
          {
            kind: "text",
            streamId: "process-stream",
            sequence: 5,
            channel: "stdout",
            data: "later batch",
          },
          {
            kind: "text",
            streamId: "process-stream",
            sequence: 6,
            channel: "stdout",
            data: "continued",
          },
        ],
      },
    );
    expect(result.events?.map((event) => event.sequence)).toEqual([5, 6]);
  });

  test("rejects noncanonical base64 and byteLength mismatch atomically", async () => {
    const ledger = open();
    const identity = command("request");
    await running(ledger, identity, "receipt");
    await expect(
      ledger.transition(identity, "receipt", "running", {
        state: "succeeded",
        completedAt,
        outcome: { kind: "fs.read", streamId: "stream", size: 1, binary: true },
        events: [
          {
            kind: "binary",
            streamId: "stream",
            sequence: 0,
            offset: 0,
            data: "YQ==",
            metadata: { encoding: "base64", byteLength: 2 },
          },
        ],
      }),
    ).rejects.toThrow("invalid stream event");
    expect((await ledger.get(identity, "receipt"))?.receipt.state).toBe(
      "running",
    );
    await expect(
      ledger.transition(identity, "receipt", "running", {
        state: "succeeded",
        completedAt,
        outcome: {
          kind: "fs.read",
          streamId: "expected-stream",
          size: 1,
          binary: false,
        },
        events: [
          {
            kind: "text",
            streamId: "other-stream",
            sequence: 0,
            channel: "file",
            data: "a",
          },
        ],
      }),
    ).rejects.toThrow("does not match outcome");
  });

  test("versions and strictly validates the schema", () => {
    const dbPath = pathFor();
    mkdirSync(join(dbPath, ".."), { recursive: true });
    const raw = new Database(dbPath, { create: true });
    raw.exec("CREATE TABLE runner_command_ledger (receipt_id TEXT)");
    raw.close();
    expect(() => open(dbPath)).toThrow("unversioned existing ledger table");

    const oldPath = pathFor();
    mkdirSync(join(oldPath, ".."), { recursive: true });
    const old = new Database(oldPath, { create: true });
    old.exec(
      "CREATE TABLE runner_command_ledger (receipt_id TEXT); PRAGMA user_version = 1",
    );
    old.close();
    expect(() => open(oldPath)).toThrow("unsupported ledger schema version 1");

    const versionedPath = pathFor();
    mkdirSync(join(versionedPath, ".."), { recursive: true });
    const raw2 = new Database(versionedPath, { create: true });
    raw2.exec("PRAGMA user_version = 99");
    raw2.close();
    expect(() => open(versionedPath)).toThrow(
      "unsupported ledger schema version 99",
    );

    const unknownPath = pathFor();
    mkdirSync(join(unknownPath, ".."), { recursive: true });
    const raw3 = new Database(unknownPath, { create: true });
    raw3.exec("CREATE TABLE unrelated (value TEXT)");
    raw3.close();
    expect(() => open(unknownPath)).toThrow(
      "unknown existing ledger database tables",
    );
  });

  test("rejects malformed persisted state/payload rows", async () => {
    const dbPath = pathFor();
    const ledger = open(dbPath);
    const identity = command("request");
    await claim(ledger, identity, "receipt");
    close(ledger);
    const raw = new Database(dbPath);
    raw
      .query(
        "UPDATE runner_command_ledger SET state = 'running' WHERE receipt_id = 'receipt'",
      )
      .run();
    raw.close();
    const reopened = open(dbPath);
    await expect(reopened.get(identity, "receipt")).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("persists across reopen and secures database paths", async () => {
    const dbPath = pathFor();
    const identity = command("request", { key: "key" });
    const first = open(dbPath);
    await claim(first, identity, "receipt");
    close(first);
    const reopened = open(dbPath);
    expect((await reopened.get(identity, "receipt"))?.operation).toEqual(
      identity.operation,
    );
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dbPath, "..")).mode & 0o777).toBe(0o700);
  });
});
