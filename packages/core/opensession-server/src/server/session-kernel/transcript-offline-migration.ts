import { Database } from "bun:sqlite";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { TranscriptStore } from "../transcript-store";
import {
  SessionKernelStore,
  sessionKernelSessionDbPath,
} from "./store";

const TABLES = [
  {
    name: "transcript_events",
    columns: "session_id, seq, uuid, ts, kind, data, full_ref, change_seq",
  },
  {
    name: "transcript_outline",
    columns: "session_id, seq, uuid, change_seq, ts, render_role, content_length, review_pr_number",
  },
  {
    name: "transcript_blobs",
    columns: "id, session_id, uuid, data",
  },
  {
    name: "transcript_sessions",
    columns: "session_id, next_seq, next_change_seq, reset_change_seq, last_ts, imported_at, import_src, import_watermark",
  },
  {
    name: "transcript_append_receipts",
    columns: "session_id, append_id, request_digest, fence_json, result_json, created_at",
  },
] as const;

type TableName = typeof TABLES[number]["name"];
type TableTotals = Record<TableName, number>;

export interface TranscriptMigrationResult {
  dryRun: boolean;
  migrated: number;
  adopted: number;
  migratedLegacyKernel: number;
  claimedTranscriptOnly: number;
  sessions: Array<{ sessionId: string; receipt: string }>;
}

function scalar(db: Database, sql: string, ...bindings: any[]): number {
  return Number((db.query(sql).get(...bindings) as { value: number }).value);
}

function emptyTotals(): TableTotals {
  return Object.fromEntries(TABLES.map(({ name }) => [name, 0])) as TableTotals;
}

function sessionTotals(db: Database, schema: "main" | "source", sessionId: string): TableTotals {
  const totals = emptyTotals();
  for (const { name } of TABLES)
    totals[name] = scalar(
      db,
      `SELECT COUNT(*) AS value FROM ${schema}.${name} WHERE session_id = ?`,
      sessionId,
    );
  return totals;
}

function addTotals(into: TableTotals, add: TableTotals): void {
  for (const { name } of TABLES) into[name] += add[name];
}

function verifySourceCoherence(db: Database, sessionId: string): void {
  const metadata = db.query(`
    SELECT next_seq, next_change_seq, reset_change_seq, last_ts, imported_at,
      import_src, import_watermark
    FROM source.transcript_sessions WHERE session_id = ?
  `).all(sessionId) as Array<{
    next_seq: number;
    next_change_seq: number;
    reset_change_seq: number;
    last_ts: number | null;
    imported_at: number | null;
    import_src: string | null;
    import_watermark: number | null;
  }>;
  if (metadata.length !== 1)
    throw new Error(`${sessionId} has ${metadata.length} transcript metadata rows`);

  const dense = db.query(`
    SELECT COUNT(*) AS count, COUNT(DISTINCT seq) AS distinct_seq,
      MIN(seq) AS min_seq, MAX(seq) AS max_seq,
      MAX(change_seq) AS max_change_seq
    FROM source.transcript_events WHERE session_id = ?
  `).get(sessionId) as {
    count: number;
    distinct_seq: number;
    min_seq: number | null;
    max_seq: number | null;
    max_change_seq: number | null;
  };
  const row = metadata[0]!;
  const expectedSeq = dense.count === 0 ? 1 : dense.count + 1;
  const expectedChange = Math.max(dense.max_change_seq ?? 0, row.reset_change_seq) + 1;
  if (
    dense.distinct_seq !== dense.count ||
    (dense.count > 0 && (dense.min_seq !== 1 || dense.max_seq !== dense.count)) ||
    row.next_seq !== expectedSeq ||
    row.next_change_seq !== expectedChange ||
    row.reset_change_seq < 0 ||
    row.reset_change_seq >= row.next_change_seq
  ) throw new Error(`${sessionId} transcript sequence metadata is incoherent`);
  if (
    (row.imported_at === null) !== (row.import_src === null) ||
    (row.imported_at === null && row.import_watermark !== null) ||
    (row.imported_at !== null && (!Number.isSafeInteger(row.imported_at) || row.imported_at < 0)) ||
    (row.last_ts !== null && (!Number.isSafeInteger(row.last_ts) || row.last_ts < 0)) ||
    (row.import_watermark !== null &&
      (!Number.isSafeInteger(row.import_watermark) || row.import_watermark < 0))
  ) throw new Error(`${sessionId} transcript import metadata is incoherent`);

  const outlineMismatch = scalar(db, `
    SELECT COUNT(*) AS value FROM (
      SELECT seq, uuid FROM (
        SELECT seq, uuid FROM source.transcript_events WHERE session_id = ?
        EXCEPT
        SELECT seq, uuid FROM source.transcript_outline WHERE session_id = ?
      )
      UNION ALL
      SELECT seq, uuid FROM (
        SELECT seq, uuid FROM source.transcript_outline WHERE session_id = ?
        EXCEPT
        SELECT seq, uuid FROM source.transcript_events WHERE session_id = ?
      )
    )
  `, sessionId, sessionId, sessionId, sessionId);
  if (outlineMismatch !== 0)
    throw new Error(`${sessionId} transcript outline is incoherent`);

  const blobMismatch = scalar(db, `
    SELECT COUNT(*) AS value
    FROM source.transcript_blobs blob
    LEFT JOIN source.transcript_events event
      ON event.full_ref = blob.id
     AND event.session_id = blob.session_id
     AND event.uuid = blob.uuid
    WHERE blob.session_id = ? AND event.seq IS NULL
  `, sessionId);
  const danglingBlobs = scalar(db, `
    SELECT COUNT(*) AS value
    FROM source.transcript_events event
    LEFT JOIN source.transcript_blobs blob
      ON blob.id = event.full_ref
     AND blob.session_id = event.session_id
     AND blob.uuid = event.uuid
    WHERE event.session_id = ? AND event.full_ref IS NOT NULL AND blob.id IS NULL
  `, sessionId);
  if (blobMismatch !== 0 || danglingBlobs !== 0)
    throw new Error(`${sessionId} transcript blob references are incoherent`);
}

function verifySession(db: Database, sessionId: string): void {
  verifySourceCoherence(db, sessionId);
  for (const table of TABLES) {
    const sourceCount = scalar(
      db,
      `SELECT COUNT(*) AS value FROM source.${table.name} WHERE session_id = ?`,
      sessionId,
    );
    const targetCount = scalar(
      db,
      `SELECT COUNT(*) AS value FROM main.${table.name} WHERE session_id = ?`,
      sessionId,
    );
    if (sourceCount !== targetCount)
      throw new Error(`${sessionId}/${table.name} count mismatch`);
    for (const [left, right] of [["main", "source"], ["source", "main"]]) {
      const difference = scalar(
        db,
        `SELECT COUNT(*) AS value FROM (
          SELECT ${table.columns} FROM ${left}.${table.name} WHERE session_id = ?
          EXCEPT
          SELECT ${table.columns} FROM ${right}.${table.name} WHERE session_id = ?
        )`,
        sessionId,
        sessionId,
      );
      if (difference !== 0)
        throw new Error(`${sessionId}/${table.name} differs ${left}->${right}`);
    }
  }

  const integrity = db.query("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  if (integrity.integrity_check !== "ok")
    throw new Error(`${sessionId} target integrity_check failed: ${integrity.integrity_check}`);
}

function receiptFor(db: Database, sessionId: string): string {
  const digest = new Bun.CryptoHasher("sha256");
  digest.update("opensession.actor-transcript-migration.v2\0");
  digest.update(sessionId);
  for (const table of TABLES) {
    const rows = db.query(
      `SELECT ${table.columns} FROM source.${table.name}
       WHERE session_id = ? ORDER BY ${table.columns}`,
    ).all(sessionId);
    digest.update(JSON.stringify(rows));
  }
  return `sha256:${digest.digest("hex")}`;
}

/** Offline, all-at-once authority cutover. The caller must stop the gateway
 * and actor service before entering. The shared source is attached for reads
 * only and is never changed or deleted. Transcript-only rows receive an
 * isolated shared-authority placement and are copied like every other row. */
export function rollbackActorTranscriptsOffline(centralPath: string): number {
  const central = new SessionKernelStore(centralPath);
  try {
    const sessionIds: string[] = [];
    let after = "";
    while (true) {
      const page = central.actorTranscriptSessionIds(1_000, after);
      sessionIds.push(...page);
      if (page.length < 1_000) break;
      after = page[page.length - 1]!;
    }
    central.rollbackActorTranscriptAuthorities(sessionIds);
    return sessionIds.length;
  } finally {
    central.close();
  }
}

export function migrateActorTranscriptsOffline(options: {
  centralPath: string;
  sourceTranscriptPath: string;
  isolatedRoot?: string;
  dryRun?: boolean;
  /** Test-only assertion seam after the source is attached read-only. */
  afterSourceAttached?: (db: Database) => void;
  /** Test-only crash seam after verified target commit, before catalog publish. */
  beforePublish?: (sessionId: string) => void;
}): TranscriptMigrationResult {
  const central = new SessionKernelStore(options.centralPath);
  const source = new Database(options.sourceTranscriptPath, { readonly: true });
  const sourceMode = statSync(options.sourceTranscriptPath).mode & 0o777;
  // Bun's SQLite binding does not enable URI filenames for ATTACH. Removing
  // write permission makes SQLite itself attach the source read-only; restore
  // the exact mode in finally. Services are required to be stopped already.
  chmodSync(options.sourceTranscriptPath, sourceMode & ~0o222);
  const isolatedRoot = options.isolatedRoot ??
    `${dirname(options.centralPath)}/session-kernel-sessions`;
  const result: TranscriptMigrationResult = {
    dryRun: options.dryRun === true,
    migrated: 0,
    adopted: 0,
    migratedLegacyKernel: 0,
    claimedTranscriptOnly: 0,
    sessions: [],
  };
  const classifiedTotals = emptyTotals();
  const verified: Array<{ sessionId: string; migrationReceipt: string }> = [];
  let auditDb: Database | undefined;
  try {
    const sessionIds = (source.query(`
      SELECT session_id FROM transcript_events
      UNION SELECT session_id FROM transcript_outline
      UNION SELECT session_id FROM transcript_blobs
      UNION SELECT session_id FROM transcript_sessions
      UNION SELECT session_id FROM transcript_append_receipts
      ORDER BY session_id
    `).all() as Array<{ session_id: string }>).map((row) => row.session_id);

    for (const sessionId of sessionIds) {
      const totals = sessionTotals(source, "main", sessionId);
      let placement = central.sessionPlacement(sessionId);
      if (options.dryRun) {
        if (!auditDb) {
          auditDb = new Database(":memory:");
          auditDb.run("ATTACH DATABASE ? AS source", [options.sourceTranscriptPath]);
          options.afterSourceAttached?.(auditDb);
        }
        verifySourceCoherence(auditDb, sessionId);
        if (!placement && central.hasSessionDurableState(sessionId))
          result.migratedLegacyKernel++;
        else if (!placement) result.claimedTranscriptOnly++;
        const receipt = receiptFor(auditDb, sessionId);
        result.sessions.push({ sessionId, receipt });
        addTotals(classifiedTotals, totals);
        continue;
      }
      if (!placement && central.hasSessionDurableState(sessionId)) {
        const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
        if (!central.migrateLegacySession(sessionId, targetPath))
          throw new Error(`Could not migrate legacy kernel placement for ${sessionId}`);
        result.migratedLegacyKernel++;
        placement = central.sessionPlacement(sessionId);
      }
      if (!placement) {
        placement = central.claimIsolatedSessionForTranscriptMigration(sessionId);
        result.claimedTranscriptOnly++;
      }
      if (placement.placement !== "isolated")
        throw new Error(`Transcript session ${sessionId} has invalid kernel placement`);

      const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
      new TranscriptStore(targetPath).close();
      const target = new Database(targetPath);
      try {
        target.run("ATTACH DATABASE ? AS source", [options.sourceTranscriptPath]);
        options.afterSourceAttached?.(target);
        verifySourceCoherence(target, sessionId);
        target.exec(`
          CREATE TABLE IF NOT EXISTS session_kernel_transcript_migrations (
            session_id TEXT PRIMARY KEY,
            receipt TEXT NOT NULL,
            verified_at INTEGER NOT NULL
          );
        `);
        const receipt = receiptFor(target, sessionId);
        const existing = target.query(
          "SELECT receipt FROM session_kernel_transcript_migrations WHERE session_id = ?",
        ).get(sessionId) as { receipt: string } | null;
        if (existing && existing.receipt !== receipt)
          throw new Error(`Session ${sessionId} target migration receipt conflict`);

        if (!existing) {
          const copy = target.transaction(() => {
            for (const table of TABLES) {
              target.run(`DELETE FROM main.${table.name} WHERE session_id = ?`, [sessionId]);
              target.run(
                `INSERT INTO main.${table.name} (${table.columns})
                 SELECT ${table.columns} FROM source.${table.name} WHERE session_id = ?`,
                [sessionId],
              );
            }
            verifySession(target, sessionId);
            target.run(
              `INSERT INTO session_kernel_transcript_migrations
                 (session_id, receipt, verified_at) VALUES (?, ?, ?)`,
              [sessionId, receipt, Date.now()],
            );
          });
          copy.immediate();
          result.migrated++;
        } else {
          verifySession(target, sessionId);
          result.adopted++;
        }
        verified.push({ sessionId, migrationReceipt: receipt });
        addTotals(classifiedTotals, totals);
        target.exec("DETACH DATABASE source");
      } finally {
        target.close();
      }
    }

    for (const { name } of TABLES) {
      const sourceTotal = scalar(source, `SELECT COUNT(*) AS value FROM ${name}`);
      if (sourceTotal !== classifiedTotals[name])
        throw new Error(
          `Global ${name} total mismatch: source=${sourceTotal}, classified=${classifiedTotals[name]}`,
        );
    }
    if (options.dryRun) return result;
    for (const { sessionId } of verified) options.beforePublish?.(sessionId);
    central.publishActorTranscriptAuthorities(verified);
    result.sessions = verified.map(({ sessionId, migrationReceipt: receipt }) => ({
      sessionId,
      receipt,
    }));
    return result;
  } finally {
    auditDb?.close();
    source.close();
    central.close();
    chmodSync(options.sourceTranscriptPath, sourceMode);
  }
}
