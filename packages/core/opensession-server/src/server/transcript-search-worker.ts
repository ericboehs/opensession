/**
 * Read-only transcript search worker.
 *
 * SQLite is synchronous in Bun. The HTTP route spawns this process lazily so
 * scanning transcript rows cannot block the coordinator's event loop. Input
 * and output are JSON over stdio; importing this module has no live effects.
 */

import { Database } from "bun:sqlite";
import { transcriptEntryMatchSnippet } from "./transcript-search";
import type { TranscriptEntry } from "./types";

const SESSION_BATCH = 200;
const CANDIDATES_PER_SESSION = 24;

export interface StoredTranscriptSearchInput {
	dbPath: string;
	query: string;
	/** Most-recent first. This order is also the result order. */
	sessionIds: string[];
	maxMatches?: number;
}

export interface StoredTranscriptMatch {
	id: string;
	snippet: string;
}

export interface StoredTranscriptSearchResult {
	matches: StoredTranscriptMatch[];
	searchedSessions: number;
}

interface CandidateRow {
	session_id: string;
	seq: number;
	data: string;
}

/** Search bounded store rows in activity-ordered session batches. */
export function searchStoredTranscripts(
	input: StoredTranscriptSearchInput,
): StoredTranscriptSearchResult {
	const query = input.query.trim();
	const maxMatches = Math.min(Math.max(1, input.maxMatches ?? 50), 100);
	if (query.length < 2 || input.sessionIds.length === 0)
		return { matches: [], searchedSessions: 0 };

	const db = new Database(input.dbPath, { readonly: true });
	const matches: StoredTranscriptMatch[] = [];
	let searchedSessions = 0;
	try {
		for (let offset = 0; offset < input.sessionIds.length; offset += SESSION_BATCH) {
			const ids = input.sessionIds.slice(offset, offset + SESSION_BATCH);
			const placeholders = ids.map(() => "?").join(",");
			const rows = db
				.query(
					`WITH ranked AS (
						SELECT session_id, seq, data,
							ROW_NUMBER() OVER (
								PARTITION BY session_id ORDER BY seq DESC
							) AS candidate_rank
						FROM transcript_events
						WHERE session_id IN (${placeholders})
							AND instr(lower(data), ?) > 0
					)
					SELECT session_id, seq, data FROM ranked
					WHERE candidate_rank <= ?`,
				)
				.all(...ids, query.toLowerCase(), CANDIDATES_PER_SESSION) as CandidateRow[];
			const bySession = new Map<string, CandidateRow[]>();
			for (const row of rows) {
				const bucket = bySession.get(row.session_id) ?? [];
				bucket.push(row);
				bySession.set(row.session_id, bucket);
			}
			for (const id of ids) {
				const candidates = (bySession.get(id) ?? []).sort((a, b) => b.seq - a.seq);
				for (const row of candidates) {
					try {
						const snippet = transcriptEntryMatchSnippet(
							JSON.parse(row.data) as TranscriptEntry,
							query,
						);
						if (!snippet) continue;
						matches.push({ id, snippet });
						break;
					} catch {}
				}
				if (matches.length >= maxMatches)
					return { matches, searchedSessions: offset + ids.length };
			}
			searchedSessions = offset + ids.length;
		}
		return { matches, searchedSessions };
	} finally {
		db.close();
	}
}

export async function runTranscriptSearchWorker(): Promise<void> {
	const input = JSON.parse(await Bun.stdin.text()) as StoredTranscriptSearchInput;
	process.stdout.write(JSON.stringify(searchStoredTranscripts(input)));
}

if (import.meta.main) {
	runTranscriptSearchWorker().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
