#!/usr/bin/env bun
/**
 * Prompt-cache hit rate per engine, per bridge, and per server pool.
 *
 *   bun scripts/cache-report.ts                 # last 7 days
 *   bun scripts/cache-report.ts --days 30
 *   bun scripts/cache-report.ts --json
 *   bun scripts/cache-report.ts --sessions 15   # worst sessions by wasted input
 *   bun scripts/cache-report.ts --prefix        # expiry vs prefix breakage
 *
 * The number this answers: of the prompt tokens we send, what fraction did the
 * provider serve from its cache rather than bill as fresh input —
 *
 *     hit rate = cacheRead / (cacheRead + uncachedInput)
 *
 * Sources are the engines' own message stores, the same ones engine-usage.ts
 * reads and for the same reason: the audit log records one `result` event per
 * TURN, but a turn is one model request per tool round, so it cannot see the
 * requests a cache either served or missed. `tokens.input` in the opencode
 * shard rows EXCLUDES the cached part (verified: `total` = input + output +
 * reasoning + cache.read + cache.write), so the ratio above is well formed for
 * both providers.
 *
 * READ THE WRITE COLUMN, NOT ONLY THE HIT RATE. The two providers bill a
 * broken prefix differently, and the hit rate alone under-detects it on one of
 * them. Anthropic reports prompt tokens in three buckets — read from cache,
 * WRITTEN to cache, and uncached — so a prefix that changed is re-cached and
 * lands in cache_creation rather than in input: the hit rate barely moves while
 * the bill roughly doubles for those tokens (a 1-hour write costs 2x base
 * input). OpenAI has no write bucket, so the same breakage does show up as
 * uncached input. `read/req` and `write/req` are therefore the honest signal on
 * both: a warm request that re-reads a full context and writes a small delta is
 * healthy, and one that reads little and writes a whole context is churning its
 * prefix, whatever the hit rate says.
 *
 * THE POOL SPLIT is the point of this script rather than a detail. Eligible
 * interactive runs multiplex onto a SHARED always-warm `opencode serve` per
 * (bridge account × user), and everything per-run rides the prompt body there —
 * including `system`, which carries the whole session-context block that a
 * per-session server delivers once in its config instead (see the "Server
 * lifecycle" note in opencode-runner.ts). A per-turn `system` that is not
 * byte-stable would invalidate the provider's prefix cache on every turn, and
 * the two pools are the natural A/B: same models, same bridges, different
 * delivery channel for the same text. The shard DB filename is the
 * discriminator — `shardDbPathForKey` sanitizes the server key, so a shared
 * pool server's DB is `shared_<bridge>_<user>.db` and everything else is
 * per-session.
 *
 * TURN POSITION is the sharper instrument. Within one turn the system prompt
 * cannot change, so a tool-round request always re-reads what the round before
 * it wrote; a prefix that is unstable ACROSS turns shows up only on the first
 * request of each turn. Those are split out, and further split by how long
 * since that session's previous request: our cache writes carry the 1-hour TTL
 * (engine-usage.ts), so a first-of-turn request less than an hour behind its
 * predecessor SHOULD hit a warm prefix. A low hit rate confined to that bucket
 * is the signature of a per-turn prefix change; a low rate everywhere is
 * ordinary cold-start traffic.
 *
 * PREFIX COVERAGE (`--prefix`) is the instrument that separates a cache that
 * aged from a prefix that changed, which the hit rate alone cannot do on
 * OpenAI. Both look identical there: OpenAI has no write bucket, so expiry and
 * breakage are both billed as uncached input. The discriminator is that a
 * request's cache read can be compared against what the request BEFORE it sent:
 *
 *     coverage = cacheRead(N) / prompt(N-1)
 *
 * If the prefix is stable, request N re-sends everything N-1 sent and should
 * read all of it back, so coverage near 1 is health and the shortfall is what a
 * perfect cache would have served. Bucketing that by the gap since the previous
 * request then tells the two apart by SHAPE rather than by level: expiry decays
 * monotonically with the gap, while a prefix that changed produces a floor that
 * is flat in the gap. A control is essential, because the comparison is only
 * meaningful between requests that are actually continuations of one another.
 * A compaction call, a different agent, or a different reasoning-effort variant
 * is a different prompt by construction, and scoring it against its predecessor
 * books a design decision as a cache failure. Those are classified out, and the
 * classification is most of what this section is for: it is what moved the
 * headline OpenAI first-of-turn number from "half the prefix misses" to a
 * decomposition in which most of the miss is not breakage at all.
 *
 * Caveats worth knowing before quoting a number. Turn position is computed from
 * the rows inside the window, so a session that straddles the start of the
 * range can have its first in-window request misread as first-of-turn (a small
 * effect at 7 days, smaller at 30). The direct engines are reported as totals
 * only: their stores are per-request transcripts with no pool and no cheap turn
 * boundary, so they get an engine-level rate and nothing finer. Coverage uses
 * `parentID` for the turn boundary rather than the user-row walk above, because
 * it survives a store whose user rows were pruned; the two agree where both
 * apply. And coverage means different things on the two providers, for the same
 * reason the hit rate does: on Anthropic a broken prefix is re-WRITTEN rather
 * than billed as input, so its coverage does fall but the shortfall lands in
 * `cache write` and costs 2x base input rather than 10x. Read Anthropic's
 * coverage next to the `uncached in` column of the cause table, where the whole
 * continuation row is a couple of thousand tokens a week: the shape is
 * comparable across providers, the money is not.
 */

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { OPENSESSION_SESSIONS_DIR } from "../packages/core/opensession-server/src/server/paths";
import { loadRates } from "../packages/core/opensession-server/src/server/engine-usage";

const SHARD_DIR = `${OPENSESSION_SESSIONS_DIR}/opencode/db`;

/**
 * Gap buckets for the first request of a turn, because "should the cache still
 * be warm?" has a different answer per provider and the coarse question is not
 * worth asking. Anthropic writes we make carry the 1-hour TTL (engine-usage.ts).
 * OpenAI's automatic caching is far shorter-lived — minutes of inactivity — so
 * an hour-wide bucket would book ordinary expiry as breakage there. Only the
 * tightest bucket is unambiguous on BOTH: a request seconds behind its
 * predecessor that still misses is a prefix that changed, not a cache that aged.
 */
const HOT_MS = 5 * 60_000;
const WARM_MS = 60 * 60_000;

/** Finer gap buckets for the coverage section. The point is the SHAPE across
 *  them, so they have to be narrow enough to show a decay starting within a
 *  couple of minutes, which the three coarse buckets above cannot. */
const GAP_BUCKETS: readonly [string, number][] = [
	["<30s", 30_000],
	["30s-1m", 60_000],
	["1-2m", 120_000],
	["2-5m", 300_000],
	["5-10m", 600_000],
	["10-20m", 1_200_000],
	["20-40m", 2_400_000],
	["40-60m", 3_600_000],
	["1-2h", 7_200_000],
	["2-6h", 21_600_000],
	[">6h", Number.POSITIVE_INFINITY],
];

function gapBucket(gap: number): string {
	for (const [name, limit] of GAP_BUCKETS) if (gap <= limit) return name;
	return ">6h";
}

/**
 * Why a request could not have read its predecessor's prompt back. Only
 * `continuation` is a fair test of prefix stability: the others send a
 * deliberately different prompt, so their miss is a design decision and
 * counting it as breakage is the measurement trap this section exists to avoid.
 */
type Cause =
	| "mid-turn (new tool output)"
	| "session start"
	| "compaction call"
	| "agent/variant/model switch"
	| "continuation";

const CAUSE_ORDER: Cause[] = [
	"mid-turn (new tool output)",
	"session start",
	"compaction call",
	"agent/variant/model switch",
	"continuation",
];

/** A prompt below this is a title/summary utility call, not a conversation;
 *  scoring one against a full context measures nothing. */
const MIN_PREV_PROMPT = 4096;

interface CoverageCell {
	requests: number;
	coverage: number;
	full: number;
	partial: number;
	zero: number;
	cacheRead: number;
	input: number;
	/** What a perfect cache would have served and did not. */
	shortfall: number;
}

function emptyCoverage(): CoverageCell {
	return { requests: 0, coverage: 0, full: 0, partial: 0, zero: 0, cacheRead: 0, input: 0, shortfall: 0 };
}

interface Agg {
	requests: number;
	/** Uncached input, i.e. what the provider billed as fresh prompt. */
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	sessions: Set<string>;
}

function emptyAgg(): Agg {
	return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sessions: new Set() };
}

function add(map: Map<string, Agg>, key: string, u: Omit<Agg, "sessions" | "requests">, session: string): void {
	let a = map.get(key);
	if (!a) map.set(key, (a = emptyAgg()));
	a.requests++;
	a.input += u.input;
	a.cacheRead += u.cacheRead;
	a.cacheWrite += u.cacheWrite;
	a.output += u.output;
	a.sessions.add(session);
}

function hitRate(a: { input: number; cacheRead: number }): number {
	const prompt = a.cacheRead + a.input;
	return prompt > 0 ? a.cacheRead / prompt : 0;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function num(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

function usd(n: number): string {
	return `$${n.toFixed(2)}`;
}

/** Pad/truncate to a fixed column width so the tables line up. */
function col(s: string, w: number, right = false): string {
	const t = s.length > w ? `${s.slice(0, w - 1)}…` : s;
	return right ? t.padStart(w) : t.padEnd(w);
}

// ── opencode shards ──

type Pool = "shared" | "per-session";

interface OpencodeScan {
	byPool: Map<Pool, Agg>;
	/** `${pool}|${provider}|${model}` */
	byModel: Map<string, Agg>;
	/** `${pool}|${provider}|${bucket}`, bucket = first-warm/first-cold/mid-turn. */
	byPosition: Map<string, Agg>;
	/** `${pool}|${provider}|${session}` → wasted uncached input on warm turns. */
	bySession: Map<string, Agg>;
	/** `${provider}|${cause}` → every request, classified by why it could not
	 *  have re-read its predecessor's prompt. Sums to all uncached input. */
	byCause: Map<string, Agg>;
	/** `${provider}|${continuation ? "cont" : "switch"}|${gapBucket}`. */
	byCoverage: Map<string, CoverageCell>;
	/** Size- and gap-matched pairs isolating the reasoning-effort variant:
	 *  `${provider}|${changed ? "changed" : "same"}`. */
	variantPairs: Map<string, CoverageCell>;
	dbs: number;
	rows: number;
}

/** The previous request in a session, kept to score the next one against. */
interface PrevRequest {
	at: number;
	prompt: number;
	parent: string;
	agent: string;
	variant: string;
	model: string;
}

type Position = "first-hot" | "first-warm" | "first-cold" | "mid-turn";

/**
 * Classify one request against its predecessor and fold it into the coverage
 * aggregates. Split out of the scan walk because the classification, not the
 * arithmetic, is the substance: every branch that is not `continuation` is a
 * request whose prompt deliberately differs from the one before it, and the
 * whole value of this section is refusing to score those as cache failures.
 */
function scoreCoverage(
	out: OpencodeScan,
	provider: string,
	u: Omit<Agg, "sessions" | "requests">,
	prev: PrevRequest | undefined,
	cur: PrevRequest,
): void {
	const sessionAgg = (cause: Cause) => {
		let a = out.byCause.get(`${provider}|${cause}`);
		if (!a) out.byCause.set(`${provider}|${cause}`, (a = emptyAgg()));
		a.requests++;
		a.input += u.input;
		a.cacheRead += u.cacheRead;
		a.cacheWrite += u.cacheWrite;
		a.output += u.output;
	};
	if (!prev) return void sessionAgg("session start");
	if (cur.parent === prev.parent) return void sessionAgg("mid-turn (new tool output)");
	if (cur.agent === "compaction") return void sessionAgg("compaction call");

	const switched = cur.agent !== prev.agent || cur.variant !== prev.variant || cur.model !== prev.model;
	sessionAgg(switched ? "agent/variant/model switch" : "continuation");
	if (prev.prompt < MIN_PREV_PROMPT) return;

	const gap = cur.at - prev.at;
	const coverage = Math.min(1, u.cacheRead / prev.prompt);
	const key = `${provider}|${switched ? "switch" : "cont"}|${gapBucket(gap)}`;
	let c = out.byCoverage.get(key);
	if (!c) out.byCoverage.set(key, (c = emptyCoverage()));
	c.requests++;
	c.coverage += coverage;
	c.cacheRead += u.cacheRead;
	c.input += u.input;
	c.shortfall += Math.max(0, Math.min(prev.prompt, cur.prompt) - u.cacheRead);
	if (coverage >= 0.95) c.full++;
	else if (coverage >= 0.05) c.partial++;
	else c.zero++;

	// The variant test. Holding agent, model, gap and prompt size fixed leaves
	// the reasoning-effort variant as the only thing that moved, so the two rows
	// are a controlled comparison rather than a correlation: nothing here can
	// have expired, and neither side sent materially more text than the other.
	if (cur.agent !== prev.agent || cur.model !== prev.model) return;
	if (gap > 120_000 || prev.prompt < 20_000) return;
	const ratio = cur.prompt / prev.prompt;
	if (ratio < 0.98 || ratio > 1.1) return;
	const pk = `${provider}|${cur.variant !== prev.variant ? "changed" : "same"}`;
	let p = out.variantPairs.get(pk);
	if (!p) out.variantPairs.set(pk, (p = emptyCoverage()));
	p.requests++;
	p.coverage += coverage;
	p.cacheRead += u.cacheRead;
	p.input += u.input;
	p.shortfall += Math.max(0, Math.min(prev.prompt, cur.prompt) - u.cacheRead);
	if (coverage >= 0.95) p.full++;
	else if (coverage >= 0.05) p.partial++;
	else p.zero++;
}

/**
 * Read every shard DB for assistant requests at or after `cutoff`.
 *
 * Rows come back ordered per session so turn position can be walked in one
 * pass: a `user` row opens a turn, the next assistant request is first-of-turn,
 * the rest are tool rounds.
 */
async function scanOpencode(cutoff: number): Promise<OpencodeScan> {
	const out: OpencodeScan = {
		byPool: new Map(),
		byModel: new Map(),
		byPosition: new Map(),
		bySession: new Map(),
		byCause: new Map(),
		byCoverage: new Map(),
		variantPairs: new Map(),
		dbs: 0,
		rows: 0,
	};
	let files: string[];
	try {
		files = readdirSync(SHARD_DIR).filter((f) => f.endsWith(".db"));
	} catch (e) {
		console.error(`[cache-report] shard dir unreadable: ${e}`);
		return out;
	}
	let scanned = 0;
	for (const file of files) {
		const path = `${SHARD_DIR}/${file}`;
		try {
			if (statSync(path).mtimeMs < cutoff) continue;
		} catch {
			continue;
		}
		const pool: Pool = file.startsWith("shared_") ? "shared" : "per-session";
		let db: Database | undefined;
		try {
			db = new Database(path, { readonly: true });
			const rows = db
				.query<{ session_id: string; time_created: number; data: string }, [number]>(
					"select session_id, time_created, data from message where time_created >= ? order by session_id, time_created",
				)
				.all(cutoff);
			out.dbs++;
			// Per-session walk state, reset when the session_id changes.
			let session = "";
			let expectFirst = false;
			let prevAt = 0;
			let prev: PrevRequest | undefined;
			for (const row of rows) {
				if (row.session_id !== session) {
					session = row.session_id;
					expectFirst = false;
					prevAt = 0;
					prev = undefined;
				}
				let d: Record<string, any>;
				try {
					d = JSON.parse(row.data);
				} catch {
					continue;
				}
				if (d.role === "user") {
					expectFirst = true;
					continue;
				}
				if (d.role !== "assistant") continue;
				const tokens = d.tokens || {};
				const cache = tokens.cache || {};
				const u = {
					input: tokens.input || 0,
					cacheRead: cache.read || 0,
					cacheWrite: cache.write || 0,
					output: tokens.output || 0,
				};
				// An aborted or still-streaming message books no usage; counting
				// it would dilute every rate with requests that never happened.
				if (u.input <= 0 && u.cacheRead <= 0) continue;
				out.rows++;
				const provider = String(d.providerID || d.model?.providerID || "?");
				const model = String(d.modelID || d.model?.modelID || "?").split("/").pop() || "?";
				const gap = prevAt > 0 ? row.time_created - prevAt : Number.POSITIVE_INFINITY;
				const position: Position = !expectFirst
					? "mid-turn"
					: gap <= HOT_MS
						? "first-hot"
						: gap <= WARM_MS
							? "first-warm"
							: "first-cold";
				add(out.byPool, pool, u, session);
				add(out.byModel, `${pool}|${provider}|${model}`, u, session);
				add(out.byPosition, `${pool}|${provider}|${position}`, u, session);
				if (position === "first-hot") add(out.bySession, `${pool}|${provider}|${session}`, u, session);

				// Prefix coverage: score this request against the one before it.
				const agent = String(d.agent || "?");
				// An absent variant is its own value, not a missing one: a request
				// opencode issued itself carries no effort where ours does, and
				// that difference is exactly what the variant test is looking for.
				const variant = d.variant === undefined ? "-" : String(d.variant);
				const prompt = u.input + u.cacheRead;
				const parent = String(d.parentID || "");
				scoreCoverage(out, provider, u, prev, {
					at: row.time_created,
					prompt,
					parent,
					agent,
					variant,
					model,
				});
				prev = { at: row.time_created, prompt, parent, agent, variant, model };

				expectFirst = false;
				prevAt = row.time_created;
			}
		} catch {
			// A shard mid-write or half-deleted is skipped, not fatal.
		} finally {
			try {
				db?.close();
			} catch {}
		}
		if (++scanned % 25 === 0) await new Promise((r) => setTimeout(r, 0));
	}
	return out;
}


// ── report ──

function totals(aggs: Iterable<Agg>): Agg {
	const t = emptyAgg();
	for (const a of aggs) {
		t.requests += a.requests;
		t.input += a.input;
		t.cacheRead += a.cacheRead;
		t.cacheWrite += a.cacheWrite;
		t.output += a.output;
		for (const s of a.sessions) t.sessions.add(s);
	}
	return t;
}

/**
 * List-price headroom: what the uncached input cost, against what the same
 * tokens would have cost had they been served from cache. Not a saving anyone
 * can bank — every model here runs on subscription capacity — but it is the
 * only comparable way to size one pool's misses against another's.
 */
function headroomUsd(key: string, a: Agg): number {
	const rate = loadRates().get(key);
	if (!rate) return 0;
	return (a.input * (rate.input - rate.cacheRead)) / 1_000_000;
}

function poolTable(scan: OpencodeScan): string[] {
	const lines = [
		`${col("pool", 14)} ${col("requests", 10, true)} ${col("sessions", 9, true)} ${col("uncached in", 12, true)} ${col("cache read", 12, true)} ${col("cache write", 12, true)} ${col("hit rate", 9, true)}`,
	];
	for (const pool of ["shared", "per-session"] as Pool[]) {
		const a = scan.byPool.get(pool);
		if (!a) continue;
		lines.push(
			`${col(pool, 14)} ${col(num(a.requests), 10, true)} ${col(num(a.sessions.size), 9, true)} ${col(num(a.input), 12, true)} ${col(num(a.cacheRead), 12, true)} ${col(num(a.cacheWrite), 12, true)} ${col(pct(hitRate(a)), 9, true)}`,
		);
	}
	return lines;
}

function positionTable(scan: OpencodeScan, minRequests: number): string[] {
	const order: Position[] = ["first-hot", "first-warm", "first-cold", "mid-turn"];
	const label: Record<Position, string> = {
		"first-hot": "1st of turn, <5m since last",
		"first-warm": "1st of turn, 5m-1h",
		"first-cold": "1st of turn, >1h/unknown",
		"mid-turn": "tool round (same turn)",
	};
	const providers = [...new Set([...scan.byPosition.keys()].map((k) => k.split("|")[1]))].sort();
	const lines = [
		`${col("pool", 12)} ${col("provider", 10)} ${col("position", 28)} ${col("reqs", 7, true)} ${col("uncached in", 12, true)} ${col("read/req", 9, true)} ${col("write/req", 9, true)} ${col("hit rate", 9, true)}`,
	];
	for (const pool of ["shared", "per-session"] as Pool[]) {
		for (const provider of providers) {
			for (const p of order) {
				const a = scan.byPosition.get(`${pool}|${provider}|${p}`);
				if (!a || a.requests < minRequests) continue;
				lines.push(
					`${col(pool, 12)} ${col(provider, 10)} ${col(label[p], 28)} ${col(num(a.requests), 7, true)} ${col(num(a.input), 12, true)} ${col(num(a.cacheRead / a.requests), 9, true)} ${col(num(a.cacheWrite / a.requests), 9, true)} ${col(pct(hitRate(a)), 9, true)}`,
				);
			}
		}
	}
	return lines;
}

function modelTable(scan: OpencodeScan, minRequests: number): string[] {
	const rows = [...scan.byModel.entries()]
		.filter(([, a]) => a.requests >= minRequests)
		.sort((a, b) => b[1].input - a[1].input);
	const lines = [
		`${col("pool", 12)} ${col("provider/model", 34)} ${col("requests", 9, true)} ${col("uncached in", 12, true)} ${col("cache read", 12, true)} ${col("hit rate", 9, true)} ${col("headroom", 10, true)}`,
	];
	for (const [key, a] of rows) {
		const [pool, provider, model] = key.split("|");
		lines.push(
			`${col(pool, 12)} ${col(`${provider}/${model}`, 34)} ${col(num(a.requests), 9, true)} ${col(num(a.input), 12, true)} ${col(num(a.cacheRead), 12, true)} ${col(pct(hitRate(a)), 9, true)} ${col(usd(headroomUsd(`${provider}|${model}`, a)), 10, true)}`,
		);
	}
	return lines;
}

function causeTable(scan: OpencodeScan, provider: string): string[] {
	const rows = CAUSE_ORDER.map((c) => [c, scan.byCause.get(`${provider}|${c}`)] as const).filter(
		(r): r is readonly [Cause, Agg] => !!r[1],
	);
	const total = rows.reduce((n, [, a]) => n + a.input, 0);
	const lines = [
		`${col("cause", 30)} ${col("requests", 9, true)} ${col("uncached in", 12, true)} ${col("share", 7, true)} ${col("read/req", 9, true)}`,
	];
	for (const [cause, a] of rows) {
		lines.push(
			`${col(cause, 30)} ${col(num(a.requests), 9, true)} ${col(num(a.input), 12, true)} ${col(pct(total ? a.input / total : 0), 7, true)} ${col(num(a.cacheRead / a.requests), 9, true)}`,
		);
	}
	return lines;
}

function coverageTable(scan: OpencodeScan, provider: string, kind: "cont" | "switch", minRequests: number): string[] {
	const lines = [
		`${col("gap since previous", 20)} ${col("reqs", 6, true)} ${col("coverage", 9, true)} ${col("full", 6, true)} ${col("partial", 8, true)} ${col("zero", 6, true)} ${col("read/req", 9, true)}`,
	];
	for (const [bucket] of GAP_BUCKETS) {
		const c = scan.byCoverage.get(`${provider}|${kind}|${bucket}`);
		if (!c || c.requests < minRequests) continue;
		lines.push(
			`${col(bucket, 20)} ${col(String(c.requests), 6, true)} ${col(pct(c.coverage / c.requests), 9, true)} ${col(pct(c.full / c.requests), 6, true)} ${col(pct(c.partial / c.requests), 8, true)} ${col(pct(c.zero / c.requests), 6, true)} ${col(num(c.cacheRead / c.requests), 9, true)}`,
		);
	}
	return lines;
}

/** The whole prefix section: coverage by gap, the variant control, and the
 *  decomposition of uncached input by cause. */
function prefixSection(scan: OpencodeScan): string[] {
	const lines: string[] = [];
	const providers = [...new Set([...scan.byCause.keys()].map((k) => k.split("|")[0]))].sort();
	for (const provider of providers) {
		lines.push(`\n── ${provider}: uncached input by cause ──`);
		lines.push(...causeTable(scan, provider));
		lines.push(`\n── ${provider}: prefix coverage on CONTINUATIONS (same agent, variant and model) ──`);
		lines.push("   (coverage = cacheRead(N) / prompt(N-1); a decay across the gap is expiry,");
		lines.push("    a flat floor that is already there at <30s is a prefix that changed)");
		lines.push(...coverageTable(scan, provider, "cont", 10));
		const sw = coverageTable(scan, provider, "switch", 10);
		if (sw.length > 1) {
			lines.push(`\n── ${provider}: the same, on agent/variant/model SWITCHES (different prompt by design) ──`);
			lines.push(...sw);
		}
		const same = scan.variantPairs.get(`${provider}|same`);
		const changed = scan.variantPairs.get(`${provider}|changed`);
		if (same?.requests && changed?.requests) {
			lines.push(`\n── ${provider}: effort-variant control (same agent+model, gap <2m, prompt size +0/+10%) ──`);
			lines.push(`${col("variant", 20)} ${col("pairs", 6, true)} ${col("coverage", 9, true)} ${col("zero", 6, true)} ${col("read/req", 9, true)}`);
			for (const [label, c] of [
				["unchanged", same],
				["changed", changed],
			] as const) {
				lines.push(
					`${col(label, 20)} ${col(String(c.requests), 6, true)} ${col(pct(c.coverage / c.requests), 9, true)} ${col(pct(c.zero / c.requests), 6, true)} ${col(num(c.cacheRead / c.requests), 9, true)}`,
				);
			}
		}
	}
	return lines;
}


async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string, fallback: number): number => {
		const i = argv.indexOf(`--${name}`);
		if (i === -1) return fallback;
		const v = Number(argv[i + 1]);
		return Number.isFinite(v) ? v : fallback;
	};
	const days = flag("days", 7);
	const minRequests = flag("min-requests", 50);
	const worstSessions = flag("sessions", 0);
	const asJson = argv.includes("--json");
	const showPrefix = argv.includes("--prefix");

	const cutoff = Date.now() - days * 86_400_000;
	const started = Date.now();
	const scan = await scanOpencode(cutoff);

	if (asJson) {
		const dumpCoverage = (m: Map<string, CoverageCell>) =>
			Object.fromEntries(
				[...m].map(([k, c]) => [
					k,
					{
						requests: c.requests,
						meanCoverage: c.requests ? c.coverage / c.requests : 0,
						full: c.full,
						partial: c.partial,
						zero: c.zero,
						cacheRead: c.cacheRead,
						input: c.input,
						shortfall: c.shortfall,
					},
				]),
			);
		const dump = (m: Map<string, Agg>) =>
			Object.fromEntries(
				[...m].map(([k, a]) => [
					k,
					{
						requests: a.requests,
						input: a.input,
						cacheRead: a.cacheRead,
						cacheWrite: a.cacheWrite,
						output: a.output,
						sessions: a.sessions.size,
						hitRate: hitRate(a),
					},
				]),
			);
		console.log(
			JSON.stringify(
				{
					days,
					since: new Date(cutoff).toISOString(),
					opencode: {
						byPool: dump(scan.byPool),
						byModel: dump(scan.byModel),
						byPosition: dump(scan.byPosition),
						byCause: dump(scan.byCause),
						byCoverage: dumpCoverage(scan.byCoverage),
						variantPairs: dumpCoverage(scan.variantPairs),
					},
				},
				null,
				2,
			),
		);
		return;
	}

	const all = totals([...scan.byPool.values()]);
	console.log(`\nPrompt cache — last ${days} day(s), since ${new Date(cutoff).toISOString().slice(0, 16)}Z`);
	console.log(`${scan.dbs} shard DBs read, ${num(scan.rows)} priced opencode requests, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

	console.log("── opencode, by server pool ──");
	for (const l of poolTable(scan)) console.log(l);

	console.log("\n── opencode, by turn position ──");
	console.log("   (a prefix that changes between turns can only hurt the FIRST request of a turn:");
	console.log("    a warm one should read a whole context and write a small delta, not the reverse)");
	for (const l of positionTable(scan, Math.min(minRequests, 20))) console.log(l);

	console.log(`\n── opencode, by model (>= ${minRequests} requests) ──`);
	for (const l of modelTable(scan, minRequests)) console.log(l);


	if (showPrefix) {
		console.log("\n── prefix coverage: did a request read back what the one before it sent? ──");
		for (const l of prefixSection(scan)) console.log(l);
	}

	if (worstSessions > 0) {
		console.log(`\n── worst ${worstSessions} sessions by uncached input on hot (<5m) first-of-turn requests ──`);
		const rows = [...scan.bySession.entries()].sort((a, b) => b[1].input - a[1].input).slice(0, worstSessions);
		for (const [key, a] of rows) {
			const [pool, provider, session] = key.split("|");
			console.log(
				`${col(pool, 12)} ${col(provider, 10)} ${col(session, 32)} ${col(`${a.requests} req`, 9, true)} ${col(num(a.input), 12, true)} ${col(pct(hitRate(a)), 9, true)}`,
			);
		}
	}

	console.log(
		`\noverall: ${pct(hitRate(all))} of ${num(all.cacheRead + all.input)} prompt tokens served from cache ` +
			`(${num(all.input)} uncached, ${num(all.cacheRead)} cached)\n`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
