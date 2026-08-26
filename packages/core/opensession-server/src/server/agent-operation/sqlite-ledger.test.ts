import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOperationIdentity } from "./ledger";
import {
  AgentOperationConflictError,
  AgentOperationLedgerFullError,
  AgentOperationSessionActiveError,
  AgentOperationTransitionError,
  reconcileExecutingOperation,
} from "./ledger";
import { SQLiteAgentOperationLedger } from "./sqlite-ledger";

const roots: string[] = [];
const path = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-operation-"));
  roots.push(root);
  return join(root, "operations.sqlite");
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const d = (c: string) => `sha256:${c.repeat(64)}` as const;
const identity = (
  overrides: Partial<AgentOperationIdentity> = {},
): AgentOperationIdentity => ({
  operationId: "operation-1",
  kind: "model",
  fence: {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
  },
  planHash: d("a"),
  authorityHash: d("b"),
  descriptor: {
    version: 1,
    kind: "model",
    stepId: "step-1",
    transcript: { throughChangeSeq: 2, entryIds: ["entry-1"], digest: d("c") },
    modelPolicyHash: d("d"),
    adapterRequestVersion: "v1",
  },
  descriptorDigest:
    "sha256:4eff910ea108e76902e2dbc225430801b9b121ea84932063a6269ef671d4ac5e",
  payloadDigest: d("f"),
  adapterId: "adapter-1",
  adapterVersion: "1.0",
  ...overrides,
});
const settlement = {
  completedAtMs: 3,
  outcome: {
    status: "succeeded" as const,
    outputDigest: d("1"),
    usage: { inputTokens: 4, outputTokens: 2 },
  },
  transcriptRefs: [
    {
      appendId: "append-1",
      entryIds: ["entry-2"],
      firstSeq: 3,
      lastSeq: 3,
      throughChangeSeq: 3,
      requestDigest: d("2"),
    },
  ],
};

describe("SQLite Agent operation ledger", () => {
  test("persists exact prepared, executing and settled replay across every reopen boundary", async () => {
    const dbPath = path();
    const exact = identity();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.claimPrepared(exact, 1)).claimed).toBe(true);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect(
      (await ledger.claimPrepared(exact, 99)).record.receipt.acceptedAtMs,
    ).toBe(1);
    expect((await ledger.markExecuting(exact, 2)).receipt.state).toBe(
      "executing",
    );
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    const terminal = await ledger.settle(exact, settlement);
    expect(terminal.receipt).toMatchObject({
      state: "settled",
      completedAtMs: 3,
      outcome: settlement.outcome,
    });
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.claimPrepared(exact, 100)).record.receipt).toEqual(
      terminal.receipt,
    );
    expect(await ledger.scanActive()).toEqual([]);
    await ledger.close();
  });

  test("serializes concurrent duplicate claims to one durable record", async () => {
    const dbPath = path();
    const first = new SQLiteAgentOperationLedger({ dbPath });
    const second = new SQLiteAgentOperationLedger({ dbPath });
    const results = await Promise.all([
      first.claimPrepared(identity(), 1),
      second.claimPrepared(identity(), 1),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results[0].record.receipt).toEqual(results[1].record.receipt);
    await first.close();
    await second.close();
  });

  test("strictly canonicalizes and verifies descriptors before any durable write", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    const malicious = identity({
      descriptor: {
        ...identity().descriptor,
        prompt: "do not persist",
        credentials: { token: "secret-value" },
      } as never,
    });
    await expect(ledger.claimPrepared(malicious, 1)).rejects.toThrow();
    await expect(
      ledger.claimPrepared(
        identity({ operationId: "operation-2", descriptorDigest: d("3") }),
        1,
      ),
    ).rejects.toThrow("descriptor digest does not match");
    const inspection = new Database(dbPath, { readonly: true });
    expect(
      JSON.stringify(
        inspection.query("SELECT * FROM agent_operation_receipts").all(),
      ),
    ).not.toMatch(/do not persist|secret-value/);
    inspection.close();
    await ledger.close();
  });

  test("atomically quarantines every exact identity mismatch without overwriting", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    const original = identity();
    await ledger.claimPrepared(original, 1);
    const mismatches: AgentOperationIdentity[] = [
      identity({
        kind: "mcp",
        descriptorDigest:
          "sha256:436fa9871b12e7650a5df3675f2683c79d080d64dcdd81a7632cb1dc9dc0eb1c",
        descriptor: {
          version: 1,
          kind: "mcp",
          toolUseEntryId: "entry-1",
          toolUseId: "use-1",
          server: "server-1",
          tool: "tool-1",
          argumentsDigest: d("9"),
          adapterRequestVersion: "v1",
        },
      }),
      identity({ fence: { ...original.fence, runId: "run-2" } }),
      identity({ fence: { ...original.fence, turnId: "turn-2" } }),
      identity({ fence: { ...original.fence, generation: 2 } }),
      identity({ planHash: d("1") }),
      identity({ authorityHash: d("2") }),
      identity({ payloadDigest: d("4") }),
      identity({ adapterId: "adapter-2" }),
      identity({ adapterVersion: "2.0" }),
    ];
    for (const mismatch of mismatches)
      await expect(ledger.claimPrepared(mismatch, 1)).rejects.toBeInstanceOf(
        AgentOperationConflictError,
      );
    expect((await ledger.getExact(original))?.quarantineReason).toContain(
      "mismatch",
    );
    expect((await ledger.getExact(original))?.planHash).toBe(original.planHash);
    expect(await ledger.scanActive()).toEqual([]);
    await expect(ledger.claimPrepared(original, 1)).rejects.toBeInstanceOf(
      AgentOperationConflictError,
    );
    await expect(ledger.markExecuting(original, 2)).rejects.toBeInstanceOf(
      AgentOperationConflictError,
    );
    await ledger.close();
  });

  test("rejects illegal and backward transitions", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    await expect(ledger.settle(exact, settlement)).rejects.toBeInstanceOf(
      AgentOperationTransitionError,
    );
    await ledger.markExecuting(exact, 2);
    await ledger.settle(exact, settlement);
    await expect(ledger.markExecuting(exact, 4)).rejects.toBeInstanceOf(
      AgentOperationTransitionError,
    );
    await expect(
      ledger.markIndeterminate(exact, "ambiguous_completion", 4),
    ).rejects.toBeInstanceOf(AgentOperationTransitionError);
    await ledger.close();
  });

  test("leaves prepared replayable and makes inherited executing visibly indeterminate when reconciliation is unsupported", async () => {
    const dbPath = path();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.claimPrepared(identity({ operationId: "operation-2" }), 1);
    await ledger.markExecuting(identity({ operationId: "operation-2" }), 2);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    const active = await ledger.scanActive();
    expect(active.map((r) => r.receipt.state)).toEqual([
      "prepared",
      "executing",
    ]);
    const recovered = await reconcileExecutingOperation(
      ledger,
      active[1],
      undefined,
      4,
    );
    expect(recovered.receipt).toMatchObject({
      state: "indeterminate",
      errorCode: "reconciliation_unsupported",
    });
    expect((await ledger.scanActive()).map((r) => r.receipt.state)).toEqual([
      "prepared",
    ]);
    await ledger.close();
  });

  test("requires exact adapter reconciliation proof and adopts a supported terminal proof", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const executing = await ledger.markExecuting(exact, 2);
    const result = await reconcileExecutingOperation(
      ledger,
      executing,
      {
        reconcile: async () => ({
          status: "settled",
          proof: {
            adapterId: exact.adapterId,
            adapterVersion: exact.adapterVersion,
            operationId: exact.operationId,
            kind: exact.kind,
            fence: exact.fence,
            planHash: exact.planHash,
            authorityHash: exact.authorityHash,
            descriptorDigest: exact.descriptorDigest,
            payloadDigest: exact.payloadDigest,
            providerResponseRef: "response-1",
          },
          settlement: { ...settlement, providerResponseRef: "response-1" },
        }),
      },
      4,
    );
    expect(result.receipt.state).toBe("settled");
    await ledger.close();
  });

  test("fails closed on malformed or contradictory reconciliation output", async () => {
    for (const malformed of [
      { status: "settled" },
      {
        status: "settled",
        proof: {
          adapterId: "adapter-1",
          adapterVersion: "1.0",
          operationId: "operation-1",
          kind: "model",
          fence: identity().fence,
          planHash: identity().planHash,
          authorityHash: identity().authorityHash,
          descriptorDigest: identity().descriptorDigest,
          payloadDigest: identity().payloadDigest,
          providerResponseRef: "different-response",
        },
        settlement,
      },
    ]) {
      const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
      const exact = identity();
      await ledger.claimPrepared(exact, 1);
      const executing = await ledger.markExecuting(exact, 2);
      const result = await reconcileExecutingOperation(
        ledger,
        executing,
        { reconcile: async () => malformed as never },
        3,
      );
      expect(result.receipt).toMatchObject({
        state: "indeterminate",
        errorCode: "reconciliation_failed",
      });
      await ledger.close();
    }
  });

  test("does not treat cancellation, timeout, AbortError or disconnect as settlement", async () => {
    for (const reason of [
      "cancellation_ambiguous",
      "timeout_ambiguous",
      "disconnect_ambiguous",
    ] as const) {
      const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
      const exact = identity();
      await ledger.claimPrepared(exact, 1);
      await ledger.markExecuting(exact, 2);
      expect(
        (await ledger.markIndeterminate(exact, reason, 3)).receipt.state,
      ).toBe("indeterminate");
      await ledger.close();
    }
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const executing = await ledger.markExecuting(exact, 2);
    const recovered = await reconcileExecutingOperation(
      ledger,
      executing,
      {
        reconcile: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      },
      3,
    );
    expect(recovered.receipt.errorCode).toBe("reconciliation_failed");
    await ledger.close();
  });

  test("enforces capacity, row bounds, retirement and authoritative session deletion", async () => {
    const ledger = new SQLiteAgentOperationLedger({
      dbPath: path(),
      capacity: 1,
    });
    await ledger.claimPrepared(identity(), 1);
    await expect(
      ledger.claimPrepared(identity({ operationId: "operation-2" }), 1),
    ).rejects.toBeInstanceOf(AgentOperationLedgerFullError);
    await expect(ledger.retireSession("session-1")).rejects.toBeInstanceOf(
      AgentOperationSessionActiveError,
    );
    expect(await ledger.deleteSession("session-1")).toBe(1);
    expect(await ledger.scanActive()).toEqual([]);
    await ledger.close();
    const bounded = new SQLiteAgentOperationLedger({
      dbPath: path(),
      maxRowBytes: 256,
    });
    await expect(bounded.claimPrepared(identity(), 1)).rejects.toBeInstanceOf(
      AgentOperationLedgerFullError,
    );
    await bounded.close();
  });

  test("creates an exact private schema with no body/secret columns or serialized payloads", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    const inspection = new Database(dbPath, { readonly: true });
    const sql = inspection
      .query<
        { sql: string },
        [string]
      >("SELECT sql FROM sqlite_master WHERE name=?")
      .get("agent_operation_receipts")!.sql;
    const columns = inspection
      .query<{ name: string }, []>(
        "PRAGMA table_info('agent_operation_receipts')",
      )
      .all()
      .map((r) => r.name);
    const rows = JSON.stringify(
      inspection.query("SELECT * FROM agent_operation_receipts").all(),
    );
    inspection.close();
    expect(sql).toContain("PRIMARY KEY(session_id,operation_id)");
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "body",
        "prompt",
        "arguments",
        "credentials",
        "headers",
        "url",
        "response_body",
      ]),
    );
    expect(rows).not.toMatch(
      /authorization|apiKey|credentials|prompt|responseBody|toolInput/i,
    );
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    await ledger.close();
  });

  test("fails closed on unsafe sidecars, schema and row tampering", async () => {
    const sidecar = path();
    const target = `${sidecar}.target`;
    writeFileSync(target, "x");
    symlinkSync(target, `${sidecar}-wal`);
    expect(() => new SQLiteAgentOperationLedger({ dbPath: sidecar })).toThrow(
      "unsafe Agent operation ledger SQLite file",
    );
    const lookalike = path();
    const weak = new Database(lookalike);
    weak.exec(`CREATE TABLE agent_operation_receipts (
      session_id TEXT, operation_id TEXT, kind TEXT, run_id TEXT, turn_id TEXT, generation INTEGER,
      plan_hash TEXT, authority_hash TEXT, descriptor_digest TEXT, payload_digest TEXT,
      adapter_id TEXT, adapter_version TEXT, state TEXT, accepted_at INTEGER, executing_at INTEGER,
      completed_at INTEGER, descriptor_json TEXT, receipt_json TEXT, quarantine_reason TEXT, ordinal INTEGER
    ); PRAGMA user_version=1;`);
    weak.close();
    expect(() => new SQLiteAgentOperationLedger({ dbPath: lookalike })).toThrow(
      "not exact STRICT schema",
    );

    const unknown = path();
    const db = new Database(unknown);
    db.exec("PRAGMA user_version=2");
    db.close();
    expect(() => new SQLiteAgentOperationLedger({ dbPath: unknown })).toThrow(
      "unsupported Agent operation ledger schema",
    );
    const tampered = path();
    let ledger = new SQLiteAgentOperationLedger({ dbPath: tampered });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    const mutation = new Database(tampered);
    mutation
      .query("UPDATE agent_operation_receipts SET receipt_json=?")
      .run('{"body":"secret"}');
    mutation.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath: tampered });
    await expect(ledger.scanActive()).rejects.toThrow(
      "corrupt Agent operation ledger row",
    );
    await ledger.close();

    const quarantinePath = path();
    ledger = new SQLiteAgentOperationLedger({ dbPath: quarantinePath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    const quarantineTamper = new Database(quarantinePath);
    quarantineTamper.exec("PRAGMA ignore_check_constraints=ON");
    quarantineTamper
      .query("UPDATE agent_operation_receipts SET quarantine_reason=?")
      .run("secret arbitrary metadata");
    quarantineTamper.close();
    expect(
      () => new SQLiteAgentOperationLedger({ dbPath: quarantinePath }),
    ).toThrow();
  });

  test("close is idempotent, drains WAL and rejects later access", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    await ledger.close();
    expect(readFileSync(dbPath).subarray(0, 16).toString()).toBe(
      "SQLite format 3\u0000",
    );
    await expect(ledger.scanActive()).rejects.toThrow("closed");
    chmodSync(dbPath, 0o644);
    const reopened = new SQLiteAgentOperationLedger({ dbPath });
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    await reopened.close();
  });
});
