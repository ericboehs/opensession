import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	type EngineUsageDay,
	decodeEngineUsageCache,
	engineUsageForDates,
	loadRates,
	nativeSessionIdFromEngineTitle,
	nativeSessionIdsForEngineSessions,
	priceDay,
	resetRatesForTest,
	scanOpencodeShards,
} from "./engine-usage";

/**
 * Pricing is the whole point of this module: the audit log's own cost field
 * reported $0 for the OpenAI pool, which hid the single largest line.
 */

let dir = "";
const prevEnv = process.env.OPENCODE_MODELS_JSON;
const prevStateDir = process.env.OPENSESSION_STATE_DIR;

const CATALOG = {
	anthropic: {
		models: {
			"claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
			"claude-fable-5": { cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 } },
		},
	},
	openai: {
		models: {
			"gpt-5.6-sol": { cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 } },
		},
	},
	// A provider whose models carry no price must not throw or count as free.
	cerebras: { models: { "gpt-oss-120b": {} } },
};

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "engine-usage-"));
	const p = join(dir, "models.json");
	writeFileSync(p, JSON.stringify(CATALOG));
	process.env.OPENCODE_MODELS_JSON = p;
	process.env.OPENSESSION_STATE_DIR = dir;
	resetRatesForTest();
});

afterAll(() => {
	if (prevEnv === undefined) delete process.env.OPENCODE_MODELS_JSON;
	else process.env.OPENCODE_MODELS_JSON = prevEnv;
	if (prevStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = prevStateDir;
	resetRatesForTest();
	rmSync(dir, { recursive: true, force: true });
});

const bucket = (input: number, output: number, cacheRead: number, cacheWrite: number, requests = 1) => ({
	requests,
	input,
	output,
	cacheRead,
	cacheWrite,
});

describe("engine usage pricing", () => {
	test("Anthropic cache writes bill at 2x input, not the catalog's 1.25x", () => {
		// Every cache write we make carries the 1-hour TTL, which is 2x base
		// input. The catalog's cache_write field is the 5-minute rate.
		const rates = loadRates();
		expect(rates.get("anthropic|claude-opus-5")?.cacheWrite).toBe(10);
		expect(rates.get("anthropic|claude-fable-5")?.cacheWrite).toBe(20);
		// Non-Anthropic providers keep the catalog rate.
		expect(rates.get("openai|gpt-5.6-sol")?.cacheWrite).toBe(6.25);
	});

	test("a day prices every model request, both providers", () => {
		const day = priceDay(
			"2026-08-14",
			new Map([
				["anthropic|claude-opus-5", bucket(1_000_000, 1_000_000, 1_000_000, 1_000_000, 3)],
				["openai|gpt-5.6-sol", bucket(1_000_000, 0, 0, 0, 2)],
			]),
		);
		// opus-5: 5 + 25 + 0.5 + 10 = 40.5;  sol: 5
		expect(day.costUsd).toBeCloseTo(45.5);
		expect(day.requests).toBe(5);
		expect(day.totalTokens).toBe(5_000_000);
		expect(day.unpricedRequests).toBe(0);
	});

	test("an unpriced model still counts its tokens but adds no cost", () => {
		const day = priceDay(
			"2026-08-14",
			new Map([
				["anthropic|claude-opus-5", bucket(1_000_000, 0, 0, 0, 1)],
				["cerebras|gpt-oss-120b", bucket(9_000_000, 0, 0, 0, 4)],
			]),
		);
		expect(day.costUsd).toBeCloseTo(5);
		expect(day.totalTokens).toBe(10_000_000);
		// Silently pricing an unknown model at zero would read as "free".
		expect(day.unpricedRequests).toBe(4);
	});

	test("a day past the store's retention is unmeasured, not zero", () => {
		// The shard DBs prune at about a month. Charting a pruned day as 0
		// would read as "usage started here", so it carries a flag instead.
		const pruned = priceDay("2026-05-20", new Map(), { opencode: "unmeasured" });
		expect(pruned.unmeasured).toBe(true);
		expect(pruned.coverage.opencode).toBe("unmeasured");
		expect(pruned.costUsd).toBe(0);
		// A day inside the window with no traffic is a real zero.
		const quiet = priceDay("2026-08-14", new Map());
		expect(quiet.unmeasured).toBe(false);
	});

	test("models are ordered by cost, so the expensive one leads", () => {
		const day = priceDay(
			"2026-08-14",
			new Map([
				["openai|gpt-5.6-sol", bucket(1_000_000, 0, 0, 0)],
				["anthropic|claude-fable-5", bucket(1_000_000, 0, 0, 0)],
			]),
		);
		expect(day.byModel[0].model).toBe("claude-fable-5");
	});
});

describe("engine usage day cache", () => {
	const cacheFixture = (date: string, day: EngineUsageDay) => {
		const cacheDir = join(dir, ".opensession-analytics-cache");
		mkdirSync(cacheDir, { recursive: true });
		const path = join(cacheDir, `engine-day-${date}.json`);
		writeFileSync(path, JSON.stringify({ v: 6, day }));
		return path;
	};

	test("preserves nonzero merged history with session-attribution provenance", async () => {
		const date = "2001-02-03";
		const legacyDay: EngineUsageDay = {
			date,
			byModel: [
				{
					provider: "anthropic",
					model: "claude-opus-5",
					requests: 7,
					input: 11,
					output: 13,
					cacheRead: 17,
					cacheWrite: 19,
					costUsd: 23,
				},
			],
			requests: 7,
			input: 11,
			output: 13,
			cacheRead: 17,
			cacheWrite: 19,
			totalTokens: 60,
			costUsd: 23,
			unpricedRequests: 5,
			// A day cached while the (since removed) direct engines existed
			// carries their coverage keys; it must decode byte-for-byte.
			coverage: {
				opencode: "measured",
				"claude-direct": "measured",
				"codex-direct": "measured",
			} as EngineUsageDay["coverage"],
			unmeasured: false,
			bySession: { "os-example": { requests: 2, output: 13 } },
			sessionAttribution: "measured",
		};
		const path = cacheFixture(date, legacyDay);

		const day = (await engineUsageForDates([date])).get(date)!;

		expect(day).toEqual(legacyDay);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ v: 6, day });
	});

	test("keeps an empty legacy retention gap unmeasured", async () => {
		const date = "2001-02-04";
		const legacyDay: EngineUsageDay = {
			date,
			byModel: [],
			requests: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			costUsd: 0,
			unpricedRequests: 0,
			coverage: {
				opencode: "unmeasured",
				"claude-direct": "measured",
				"codex-direct": "measured",
			} as EngineUsageDay["coverage"],
			unmeasured: true,
			sessionAttribution: "unmeasured",
		};
		cacheFixture(date, legacyDay);

		const day = (await engineUsageForDates([date])).get(date)!;

		expect(day.unmeasured).toBe(true);
		expect(day.coverage).toEqual({
			opencode: "unmeasured",
			"claude-direct": "measured",
			"codex-direct": "measured",
		} as EngineUsageDay["coverage"]);
	});

	test("preserves v3/v4 totals but requires a session-attribution rescan", () => {
		for (const version of [3, 4]) {
			const day = decodeEngineUsageCache({
				v: version,
				day: {
					date: "2026-08-01",
					byModel: [],
					requests: 2,
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					costUsd: 1,
					unpricedRequests: 0,
					unmeasured: false,
				},
			});

			expect(day).toMatchObject({ output: 20, totalTokens: 100, unmeasured: false });
			expect(day?.coverage).toEqual({ opencode: "measured" });
			expect(day?.sessionAttribution).toBeUndefined();
			expect(day?.bySession).toBeUndefined();
		}
	});
});

describe("OpenCode session attribution", () => {
	test("extracts both generations of native session title", () => {
		expect(nativeSessionIdFromEngineTitle("backstage bks-019fa8ad-bbdd-7000-8481-be3f03496e34")).toBe(
			"bks-019fa8ad-bbdd-7000-8481-be3f03496e34",
		);
		expect(nativeSessionIdFromEngineTitle("opensession os-01a00f25-bdc6-7000-8066-8f36942aa807")).toBe(
			"os-01a00f25-bdc6-7000-8066-8f36942aa807",
		);
		expect(nativeSessionIdFromEngineTitle("unrelated smoke test")).toBeNull();
	});

	test("inherits native attribution through internal task parents", () => {
		const ids = nativeSessionIdsForEngineSessions([
			{
				id: "parent",
				parent_id: null,
				title: "opensession os-01a00f25-bdc6-7000-8066-8f36942aa807",
			},
			{ id: "task", parent_id: "parent", title: "Review os-019ff721-ccbf-7001-9b8d-a16afb94670e" },
			{ id: "oracle", parent_id: "task", title: "Oracle" },
		]);

		expect(ids.get("oracle")).toBe("os-01a00f25-bdc6-7000-8066-8f36942aa807");
	});

	test("attributes every assistant request in a shard to its native session", async () => {
		const root = join(dir, "opencode-shards");
		mkdirSync(root, { recursive: true });
		const db = new Database(join(root, "fixture.db"), { create: true });
		db.exec("create table session (id text primary key, parent_id text, title text not null)");
		db.exec("create table message (id text primary key, session_id text not null, time_created integer not null, data text not null)");
		db.query("insert into session (id, title) values (?, ?)").run(
			"engine-session",
			"opensession os-01a00f25-bdc6-7000-8066-8f36942aa807",
		);
		db.query("insert into session (id, parent_id, title) values (?, ?, ?)").run(
			"task-session",
			"engine-session",
			"Review the implementation",
		);
		const insert = db.query("insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)");
		for (const [id, at, output] of [
			["m1", "2026-08-14T10:00:00Z", 20],
			["m2", "2026-08-14T10:01:00Z", 30],
			["m3", "2026-08-14T10:02:00Z", 40],
		] as const) {
			insert.run(
				id,
				id === "m3" ? "task-session" : "engine-session",
				Date.parse(at),
				JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol", tokens: { output } }),
			);
		}
		db.close();

		const days = new Map();
		const sessions = new Map();
		const scan = await scanOpencodeShards(days, sessions, CUTOFF, root);

		expect(sessions.get("2026-08-14")?.get("os-01a00f25-bdc6-7000-8066-8f36942aa807")).toEqual({
			requests: 3,
			output: 90,
		});
		expect(days.get("2026-08-14")?.get("openai|gpt-5.6-sol")?.output).toBe(90);
		expect(scan.complete).toBe(true);
	});
});

const CUTOFF = Date.parse("2026-08-10T00:00:00Z");
