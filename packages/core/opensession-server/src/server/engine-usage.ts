/**
 * Engine usage: tokens and cost per day, read from the engines' own message
 * stores rather than from our audit log.
 *
 * Why not the audit log. It records one `result` event per TURN, but a turn is
 * one model request per tool round, and the sub-sessions a turn spawns (task
 * tool, oracles) never surface as turns at all. Even with per-turn usage summed
 * correctly (see buildTurnResultEvents), the audit log cannot see the requests
 * that belong to no turn of ours, and everything it recorded before 2026-08-14
 * kept only each turn's LAST request. Measured over 30 days to 2026-08-14, the
 * audit-derived figures read 2.5B tokens and $2.8K against a true 78B and $86K.
 *
 * ONE SOURCE per engine, because each engine keeps its own book and
 * none of them writes to another's. Today that is a single source:
 *
 *  - opencode: the per-session shard DBs under
 *    ~/.opensession-sessions/opencode/db/*.db (plus the shared-pool servers'
 *    own DBs in the same directory). Each assistant row in `message` is exactly
 *    one model request, with its own token counts, so summing them is the real
 *    number for both providers. Cross-checked against the Claude Agent SDK
 *    transcripts in ~/.opensession-opencode/meridian-cfg (an entirely separate
 *    record, one line per API request): the two agree to within 10% on
 *    Anthropic, the shard DBs reading slightly low because a deleted session
 *    takes its DB with it.
 *
 * The pi engine runs THROUGH these same records (its Anthropic turns ride the
 * shared bridge and its usage lands in the same shard DBs the scanner reads),
 * so it needs no source of its own. The removed direct-SDK engines
 * (claude-direct, codex-direct) had scanners here; they only ever recorded
 * about 11 smoke transcripts, and past days holding that usage stay valid in
 * the per-day cache below. Their state dirs (~/.opensession-claude-direct,
 * ~/.opensession-codex-direct) remain on disk as historical records that
 * nothing reads anymore.
 *
 * Adding an engine means adding a source here, and nothing else will catch the
 * omission: the audit log's `result` events carry no engine field, so an engine
 * we do not read reads as zero rather than as missing.
 *
 * Cost is an API LIST-PRICE EQUIVALENT, not spend. Every model here runs on a
 * subscription pool, so nothing is billed per token; this is what the same
 * traffic would have cost on the API, which is the only comparable figure. The
 * engine's own `cost` field is deliberately ignored: it reports 0 for the
 * OpenAI pool, which silently erased the single largest line.
 *
 * Rates come from opencode's model catalog (~/.cache/opencode/models.json),
 * which was independently confirmed by fitting cost against tokens over 30k
 * priced messages at 0.0000% error. One deviation: Anthropic cache writes are
 * priced at 2x base input, not the catalog's 1.25x, because every cache write
 * we make carries the 1-hour TTL (verified from the SDK transcripts, which
 * split ephemeral_1h from ephemeral_5m: 2.58B tokens to 1h, zero to 5m).
 *
 * Retention. opencode prunes the shard DBs, which held ~30 days when this was
 * written. A day older than the store's earliest row is therefore not zero
 * usage, it is NO DATA, and the two must never render the same way: a 90-day
 * range would otherwise draw 60 days of flat zero and read as "we started in
 * July". Coverage is tracked per source. A merged day is only globally
 * `unmeasured` when the missing source leaves no usage to display. The per-day
 * cache below is what makes history outlive the source, so a day measured once
 * stays measured: it is the durable record, and the prewarm is what keeps it
 * ahead of the pruning.
 */

import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isNativeSessionId, OPENSESSION_SESSIONS_DIR, stateDir } from "./paths";

const SHARD_DIR = `${OPENSESSION_SESSIONS_DIR}/opencode/db`;


export interface ModelUsage {
	provider: string;
	model: string;
	/** Model requests, i.e. assistant messages. Not turns. */
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export type EngineUsageSource = "opencode";
export type EngineUsageCoverage = Record<EngineUsageSource, "measured" | "unmeasured">;

export interface EngineUsageDay {
	date: string;
	byModel: ModelUsage[];
	/** OpenCode requests attributed to their native Open Session session. Direct
	 *  engines do not currently expose this link, so callers fall back to audit
	 *  output for sessions absent from this map. */
	bySession?: Record<string, { requests: number; output: number }>;
	/** Whether the OpenCode store still retained enough history to build
	 *  `bySession` for this day. */
	sessionAttribution?: "measured" | "unmeasured";
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costUsd: number;
	/** Requests on a model with no catalog price, excluded from costUsd. */
	unpricedRequests: number;
	/** Whether each source has complete data for this day. */
	coverage: EngineUsageCoverage;
	/** Every source with retained usage is empty, while at least one source is
	 *  outside its retention horizon. Never chart this day as zero. */
	unmeasured: boolean;
}

function measuredCoverage(): EngineUsageCoverage {
	return { opencode: "measured" };
}

// ── Rates ──

interface Rate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Anthropic's 1-hour cache TTL bills at 2x base input; the catalog carries
 *  the 5-minute rate (1.25x). Every write we make is 1-hour. */
const ANTHROPIC_CACHE_WRITE_MULTIPLE = 2;

let rateCache: { at: number; rates: Map<string, Rate> } | null = null;

function catalogPath(): string {
	return process.env.OPENCODE_MODELS_JSON || `${homedir()}/.cache/opencode/models.json`;
}

/** provider+model → per-million-token rates, from opencode's catalog. */
export function loadRates(): Map<string, Rate> {
	if (rateCache && Date.now() - rateCache.at < 3_600_000) return rateCache.rates;
	const rates = new Map<string, Rate>();
	try {
		const raw = JSON.parse(readFileSync(catalogPath(), "utf-8")) as Record<string, unknown>;
		for (const [providerId, provider] of Object.entries(raw)) {
			const models = (provider as { models?: Record<string, { cost?: Record<string, number> }> })?.models;
			if (!models) continue;
			for (const [modelId, model] of Object.entries(models)) {
				const cost = model?.cost;
				if (!cost || typeof cost.input !== "number") continue;
				const input = cost.input;
				const cacheWrite =
					providerId === "anthropic"
						? input * ANTHROPIC_CACHE_WRITE_MULTIPLE
						: (cost.cache_write ?? input * 1.25);
				rates.set(`${providerId}|${modelId}`, {
					input,
					output: cost.output ?? 0,
					cacheRead: cost.cache_read ?? 0,
					cacheWrite,
				});
			}
		}
	} catch (e) {
		console.error("[engine-usage] model catalog read failed:", e);
	}
	rateCache = { at: Date.now(), rates };
	return rates;
}

/** Drop the memoized catalog. Tests point OPENCODE_MODELS_JSON at a fixture. */
export function resetRatesForTest(): void {
	rateCache = null;
}

// ── Scan ──

interface Bucket {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function emptyBucket(): Bucket {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function utcDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export interface EngineUsageScan {
	days: Map<string, Map<string, Bucket>>;
	sessions: Map<string, Map<string, { requests: number; output: number }>>;
	/** False when a relevant OpenCode shard could not be read. Partial session
	 *  attribution must never be cached as complete. */
	sessionAttributionComplete: boolean;
	/** UTC date of the earliest surviving row in the OPENCODE store, or null if
	 *  it is empty. That store prunes, so a day before this one has nothing left
	 *  to read and is unmeasured rather than zero. The direct-engine stores
	 *  deliberately do not bound this — see the retention note up top. */
	earliest: string | null;
}

/** The runner names engine sessions `opensession <native-id>` (historically
 *  `backstage <native-id>`). Keep the prefix opaque and accept both native ID
 *  generations through the shared predicate. */
export function nativeSessionIdFromEngineTitle(title: string): string | null {
	for (const part of title.trim().split(/\s+/)) {
		if (isNativeSessionId(part)) return part;
	}
	return null;
}

interface EngineSessionRow {
	id: string;
	parent_id: string | null;
	title: string;
}

/** OpenCode's internal task/oracle sessions have descriptive titles and point
 *  at the owning engine session through parent_id. Resolve that chain to the
 *  nearest native Open Session id so their requests stay with the person and
 *  repo that spawned them. */
export function nativeSessionIdsForEngineSessions(rows: EngineSessionRow[]): Map<string, string> {
	const sessions = new Map(rows.map((row) => [row.id, row]));
	const resolved = new Map<string, string>();
	const resolving = new Set<string>();
	const resolve = (id: string): string | null => {
		const cached = resolved.get(id);
		if (cached) return cached;
		if (resolving.has(id)) return null;
		const row = sessions.get(id);
		if (!row) return null;
		resolving.add(id);
		const native = (row.parent_id ? resolve(row.parent_id) : null) || nativeSessionIdFromEngineTitle(row.title);
		resolving.delete(id);
		if (native) resolved.set(id, native);
		return native;
	};
	for (const id of sessions.keys()) resolve(id);
	return resolved;
}

function addSessionUsage(
	sessions: EngineUsageScan["sessions"],
	date: string,
	sessionId: string,
	output: number,
): void {
	let bySession = sessions.get(date);
	if (!bySession) sessions.set(date, (bySession = new Map()));
	const bucket = bySession.get(sessionId) || { requests: 0, output: 0 };
	bucket.requests++;
	bucket.output += output;
	bySession.set(sessionId, bucket);
}

/** Bucket one model request into a day. */
function addUsage(
	days: Map<string, Map<string, Bucket>>,
	date: string,
	provider: string,
	model: string,
	u: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
	let byModel = days.get(date);
	if (!byModel) days.set(date, (byModel = new Map()));
	const key = `${provider}|${model}`;
	let b = byModel.get(key);
	if (!b) byModel.set(key, (b = emptyBucket()));
	b.requests++;
	b.input += u.input;
	b.output += u.output;
	b.cacheRead += u.cacheRead;
	b.cacheWrite += u.cacheWrite;
}

/** Every matching file under `root`, depth-first. A missing root yields none. */
function filesUnder(root: string, match: (name: string) => boolean): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = `${dir}/${e.name}`;
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && match(e.name)) out.push(p);
		}
	};
	walk(root);
	return out;
}

/**
 * Scan every opencode shard DB for assistant messages at or after `cutoff`,
 * bucketed by UTC day and provider+model. Returns how far back the store still
 * reaches, which is what makes a pruned day unmeasured rather than zero.
 *
 * Yields to the event loop between databases: a full scan is ~4k files and
 * about a minute of CPU, and the server serves HTTP throughout.
 */
export async function scanOpencodeShards(
	days: Map<string, Map<string, Bucket>>,
	sessions: EngineUsageScan["sessions"],
	cutoff: number,
	root: string = SHARD_DIR,
): Promise<{ earliest: string | null; complete: boolean }> {
	let earliestMs = Number.POSITIVE_INFINITY;
	let complete = true;
	let files: string[];
	try {
		files = readdirSync(root).filter((f) => f.endsWith(".db"));
	} catch (e) {
		console.error("[engine-usage] shard dir unreadable:", e);
		return { earliest: null, complete: false };
	}
	let scanned = 0;
	for (const file of files) {
		const path = `${root}/${file}`;
		// A DB last written before the cutoff cannot hold rows after it.
		try {
			if (statSync(path).mtimeMs < cutoff) continue;
		} catch {
			complete = false;
			continue;
		}
		let db: Database | undefined;
		try {
			db = new Database(path, { readonly: true });
			const tables = new Set(
				db
					.query<{ name: string }, []>("select name from sqlite_master where type = 'table'")
					.all()
					.map((row) => row.name),
			);
			// OpenCode can leave a valid but uninitialized SQLite file behind when
			// startup stops before migrations. It contains no usage to lose.
			if (!tables.has("session") && !tables.has("message")) continue;
			if (!tables.has("session") || !tables.has("message")) {
				throw new Error("OpenCode shard is missing the session or message table");
			}
			const nativeSessionIds = nativeSessionIdsForEngineSessions(
				db.query<EngineSessionRow, []>("select id, parent_id, title from session").all(),
			);
			// How far back the store still reaches. A DB skipped above cannot
			// lower this into the requested range: every row in it predates the
			// cutoff, which is the range's own start.
			const first = db.query<{ t: number | null }, []>("select min(time_created) t from message").get();
			if (first?.t) earliestMs = Math.min(earliestMs, first.t);
			const page = db.query<
				{ id: string; time_created: number; data: string; session_id: string },
				[number, number, number, string, number]
			>(
				"select id, time_created, data, session_id from message " +
					"where time_created >= ? and (time_created > ? or (time_created = ? and id > ?)) " +
					"order by time_created, id limit ?",
			);
			let cursorTime = cutoff;
			let cursorId = "";
			while (true) {
				// Shared-pool shards can hold hundreds of thousands of requests. Read
				// bounded pages so one synchronous SQLite call cannot starve the
				// server's timers or retain the whole range in memory.
				const rows = page.all(cutoff, cursorTime, cursorTime, cursorId, 2_000);
				for (const row of rows) {
					let d: Record<string, any>;
					try {
						d = JSON.parse(row.data);
					} catch {
						continue;
					}
					if (d.role !== "assistant") continue;
					const tokens = d.tokens || {};
					const cache = tokens.cache || {};
					const provider = String(d.providerID || d.model?.providerID || "?");
					const model = String(d.modelID || d.model?.modelID || "?").split("/").pop() || "?";
					const date = utcDate(row.time_created);
					addUsage(days, date, provider, model, {
						input: tokens.input || 0,
						output: tokens.output || 0,
						cacheRead: cache.read || 0,
						cacheWrite: cache.write || 0,
					});
					const sessionId = nativeSessionIds.get(row.session_id);
					if (sessionId) addSessionUsage(sessions, date, sessionId, tokens.output || 0);
				}
				if (rows.length < 2_000) break;
				const last = rows[rows.length - 1]!;
				cursorTime = last.time_created;
				cursorId = last.id;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		} catch (error) {
			// A shard mid-write or half-deleted is skipped, not fatal.
			console.error(`[engine-usage] shard unreadable: ${path}`, error);
			complete = false;
		} finally {
			try {
				db?.close();
			} catch {}
		}
		if (++scanned % 25 === 0) await new Promise((r) => setTimeout(r, 0));
	}
	return {
		earliest: Number.isFinite(earliestMs) ? utcDate(earliestMs) : null,
		complete,
	};
}

/**
 * Every engine's usage for days at or after `fromDate`, merged into one set of
 * per-day, per-model buckets. A model run on two engines aggregates into one
 * row, which is what makes the totals comparable.
 */
export async function scanEngineUsage(fromDate: string): Promise<EngineUsageScan> {
	const days = new Map<string, Map<string, Bucket>>();
	const sessions: EngineUsageScan["sessions"] = new Map();
	const cutoff = Date.parse(`${fromDate}T00:00:00Z`);
	if (!Number.isFinite(cutoff)) return { days, sessions, earliest: null, sessionAttributionComplete: false };
	const opencode = await scanOpencodeShards(days, sessions, cutoff);
	return {
		days,
		sessions,
		earliest: opencode.earliest,
		sessionAttributionComplete: opencode.complete,
	};
}

/** Price one day's buckets. */
export function priceDay(
	date: string,
	byModel: Map<string, Bucket>,
	coverage: EngineUsageCoverage = measuredCoverage(),
	bySession: Map<string, { requests: number; output: number }> = new Map(),
): EngineUsageDay {
	const rates = loadRates();
	const day: EngineUsageDay = {
		date,
		byModel: [],
		bySession: Object.fromEntries(bySession),
		sessionAttribution: coverage.opencode === "unmeasured" ? "unmeasured" : "measured",
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
		unpricedRequests: 0,
		coverage,
		unmeasured: false,
	};
	for (const [key, b] of byModel) {
		const [provider, model] = key.split("|");
		const rate = rates.get(key);
		const costUsd = rate
			? (b.input * rate.input +
					b.output * rate.output +
					b.cacheRead * rate.cacheRead +
					b.cacheWrite * rate.cacheWrite) /
				1_000_000
			: 0;
		if (!rate) day.unpricedRequests += b.requests;
		day.byModel.push({ provider, model, ...b, costUsd });
		day.requests += b.requests;
		day.input += b.input;
		day.output += b.output;
		day.cacheRead += b.cacheRead;
		day.cacheWrite += b.cacheWrite;
		day.costUsd += costUsd;
	}
	day.totalTokens = day.input + day.output + day.cacheRead + day.cacheWrite;
	day.unmeasured = day.requests === 0 && Object.values(coverage).includes("unmeasured");
	day.byModel.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
	return day;
}

export function emptyEngineUsageDay(date: string): EngineUsageDay {
	return priceDay(date, new Map());
}

// ── Per-day cache ──
//
// Same shape as the analytics day rollups: a past day is final and cached
// forever, today is recomputed. One scan fills every day it covers, so a cold
// range costs one pass rather than one per day.

// 2: days before the store's earliest row carry `unmeasured` instead of zeros.
// 3: the (since removed) direct engines were counted. Cached days written
//    while they existed keep that usage and their extra coverage keys; both
//    decode fine and the history stays explainable.
// 4: OpenCode requests carry direct native-session attribution.
// 5: Internal OpenCode task sessions inherit attribution through parent_id.
// 6: Parent ownership wins when a task title happens to mention another id.
//    Version 3/4 totals are preserved while retained days are rescanned once.
const CACHE_VERSION = 6;

// Reuse the analytics cache directory so both rollups age together.
const stateCacheDir = () => stateDir("analytics-cache");

function cachePath(date: string): string {
	return `${stateCacheDir()}/engine-day-${date}.json`;
}

/** Decode the current cache shape and older aggregate-compatible shapes. Old
 *  versions leave sessionAttribution absent so retained days are rescanned. */
export function decodeEngineUsageCache(parsed: unknown): EngineUsageDay | null {
	const value = parsed as { v?: number; day?: EngineUsageDay & { coverage?: EngineUsageCoverage } };
	if ((value?.v !== CACHE_VERSION && value?.v !== 4 && value?.v !== 3) || !value.day) return null;
	const cached = value.day;
	if (value.v === CACHE_VERSION) return cached;
	return {
		...cached,
		coverage:
			cached.coverage || {
				...measuredCoverage(),
				opencode: cached.unmeasured ? "unmeasured" : "measured",
			},
		unmeasured: !!cached.unmeasured && cached.requests === 0,
		bySession: undefined,
		sessionAttribution: undefined,
	};
}

function readDay(date: string): EngineUsageDay | null {
	try {
		const p = cachePath(date);
		if (!existsSync(p)) return null;
		return decodeEngineUsageCache(JSON.parse(readFileSync(p, "utf-8")));
	} catch {
		return null;
	}
}

function writeDay(day: EngineUsageDay): void {
	try {
		mkdirSync(stateCacheDir(), { recursive: true });
		writeFileSync(cachePath(day.date), JSON.stringify({ v: CACHE_VERSION, day }));
	} catch (e) {
		console.error("[engine-usage] day cache write failed:", e);
	}
}

let inflight: Promise<void> | null = null;
const VOLATILE_DAY_TTL_MS = 60_000;
const volatileDays = new Map<string, { at: number; day: EngineUsageDay }>();

function cachedUsageDay(date: string, today: string): EngineUsageDay | null {
	if (date < today) return readDay(date);
	const cached = volatileDays.get(date);
	return cached && Date.now() - cached.at < VOLATILE_DAY_TTL_MS ? cached.day : null;
}

/**
 * Usage for each of `dates`, cached per day. Today is always rescanned; a past
 * day is served from cache when present. Concurrent callers share one scan.
 */
export async function engineUsageForDates(dates: string[]): Promise<Map<string, EngineUsageDay>> {
	const today = new Date().toISOString().slice(0, 10);
	const out = new Map<string, EngineUsageDay>();
	const missing: string[] = [];
	for (const date of dates) {
		const cached = cachedUsageDay(date, today);
		if (cached) out.set(date, cached);
		if (!cached || !cached.sessionAttribution) missing.push(date);
	}
	if (!missing.length) return out;

	// One scan from the earliest missing day fills all of them.
	while (inflight) await inflight;
	let resolveInflight!: () => void;
	inflight = new Promise<void>((r) => (resolveInflight = r));
	try {
		// Re-check: a concurrent scan may have filled these while we waited.
		const stillMissing = missing.filter((d) => {
			const cached = cachedUsageDay(d, today);
			return !cached?.sessionAttribution;
		});
		if (stillMissing.length) {
			const scanFrom = stillMissing.reduce((a, b) => (a < b ? a : b));
			const { days: scanned, sessions, earliest, sessionAttributionComplete } = await scanEngineUsage(scanFrom);
			for (const date of stillMissing) {
				// Only OpenCode prunes. Keep that source's gap separate from the
				// direct-engine values merged into the same day.
				const coverage = measuredCoverage();
				if (earliest && date < earliest) coverage.opencode = "unmeasured";
				const existing = cachedUsageDay(date, today);
				const canAttribute = sessionAttributionComplete && coverage.opencode === "measured";
				const bySession = sessions.get(date) ?? new Map();
				const day = existing
					? {
							...existing,
							...(canAttribute ? { bySession: Object.fromEntries(bySession) } : {}),
							sessionAttribution: canAttribute ? ("measured" as const) : ("unmeasured" as const),
						}
					: priceDay(date, scanned.get(date) ?? new Map(), coverage, bySession);
				if (!canAttribute) {
					delete day.bySession;
					day.sessionAttribution = "unmeasured";
				}
				if (date < today) {
					// A partial scan stays eligible for another attribution attempt.
					if (sessionAttributionComplete) writeDay(day);
				} else {
					volatileDays.set(date, { at: Date.now(), day });
				}
				out.set(date, day);
			}
			for (const date of missing) {
				if (!out.has(date)) out.set(date, cachedUsageDay(date, today) ?? emptyEngineUsageDay(date));
			}
		} else {
			for (const date of missing) out.set(date, cachedUsageDay(date, today) ?? emptyEngineUsageDay(date));
		}
	} finally {
		resolveInflight();
		inflight = null;
	}
	for (const date of dates) if (!out.has(date)) out.set(date, emptyEngineUsageDay(date));
	return out;
}
