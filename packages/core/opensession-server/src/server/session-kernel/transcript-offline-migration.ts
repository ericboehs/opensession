import { Database } from "bun:sqlite";
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

export interface TranscriptMigrationResult {
  migrated: number;
  adopted: number;
  skippedUnplaced: number;
  sessions: Array<{ sessionId: string; receipt: string }>;
}

function scalar(db: Database, sql: string, ...bindings: any[]): number {
  return Number((db.query(sql).get(...bindings) as { value: number }).value);
}

function verifySession(db: Database, sessionId: string): void {
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

  const danglingBlobs = scalar(
    db,
    `SELECT COUNT(*) AS value
     FROM transcript_events event
     LEFT JOIN transcript_blobs blob
       ON blob.id = event.full_ref
      AND blob.session_id = event.session_id
      AND blob.uuid = event.uuid
     WHERE event.session_id = ?
       AND event.full_ref IS NOT NULL
       AND blob.id IS NULL`,
    sessionId,
  );
  if (danglingBlobs !== 0)
    throw new Error(`${sessionId} has ${danglingBlobs} dangling transcript blobs`);

  const highWater = db.query(`
    SELECT next_seq, next_change_seq, reset_change_seq,
      COALESCE((SELECT MAX(seq) + 1 FROM transcript_events WHERE session_id = ?), 1) AS expected_seq,
      COALESCE((SELECT MAX(change_seq) + 1 FROM transcript_events WHERE session_id = ?), 1) AS expected_change
    FROM transcript_sessions WHERE session_id = ?
  `).get(sessionId, sessionId, sessionId) as {
    next_seq: number;
    next_change_seq: number;
    reset_change_seq: number;
    expected_seq: number;
    expected_change: number;
  } | null;
  if (!highWater)
    throw new Error(`${sessionId} has no transcript session metadata`);
  if (
    highWater.next_seq !== highWater.expected_seq ||
    highWater.next_change_seq !== highWater.expected_change ||
    highWater.reset_change_seq >= highWater.next_change_seq
  ) throw new Error(`${sessionId} transcript high-water verification failed`);

  const integrity = db.query("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  if (integrity.integrity_check !== "ok")
    throw new Error(`${sessionId} target integrity_check failed: ${integrity.integrity_check}`);
}

function receiptFor(db: Database, sessionId: string): string {
  const digest = new Bun.CryptoHasher("sha256");
  digest.update("opensession.actor-transcript-migration.v1\0");
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
 * only and is never changed or deleted. */
export function migrateActorTranscriptsOffline(options: {
  centralPath: string;
  sourceTranscriptPath: string;
  isolatedRoot?: string;
  /** Test-only crash seam after verified target commit, before catalog publish. */
  beforePublish?: (sessionId: string) => void;
}): TranscriptMigrationResult {
  const central = new SessionKernelStore(options.centralPath);
  const source = new Database(options.sourceTranscriptPath, { readonly: true });
  const isolatedRoot = options.isolatedRoot ??
    `${dirname(options.centralPath)}/session-kernel-sessions`;
  const result: TranscriptMigrationResult = {
    migrated: 0,
    adopted: 0,
    skippedUnplaced: 0,
    sessions: [],
  };
  try {
    const sessionIds = (source.query(
      "SELECT session_id FROM transcript_sessions ORDER BY session_id",
    ).all() as Array<{ session_id: string }>).map((row) => row.session_id);
    for (const sessionId of sessionIds) {
      const placement = central.sessionPlacement(sessionId);
      if (!placement || placement.placement !== "isolated") {
        // Shared stores contain old test probes, removed sessions, and plain
        // file-backed runs. They have no actor authority to move and remain
        // only in the untouched rollback source.
        result.skippedUnplaced++;
        continue;
      }
      const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
      new TranscriptStore(targetPath).close();
      const target = new Database(targetPath);
      try {
        target.run("ATTACH DATABASE ? AS source", [options.sourceTranscriptPath]);
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
        options.beforePublish?.(sessionId);
        central.publishActorTranscriptAuthority(sessionId, receipt);
        result.sessions.push({ sessionId, receipt });
        target.exec("DETACH DATABASE source");
      } finally {
        target.close();
      }
    }
    return result;
  } finally {
    source.close();
    central.close();
  }
}
