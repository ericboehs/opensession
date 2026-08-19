import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import {
	ASSETS_ROOT,
	deleteAssetAcross,
	findAssetPath,
	listAssetsAcross,
	writeAsset,
} from "./session-assets";
import { sessionIdsFor } from "./session-cache";
import type { UnifiedSession } from "./types";

const canonicalId = `test-assets-canonical-${process.pid}`;
const aliasId = `test-assets-alias-${process.pid}`;

afterEach(() => {
	rmSync(`${ASSETS_ROOT}/${canonicalId}`, { recursive: true, force: true });
	rmSync(`${ASSETS_ROOT}/${aliasId}`, { recursive: true, force: true });
});

describe("session asset aliases", () => {
	test("returns the canonical id before historical aliases", () => {
		const session = {
			id: canonicalId,
			aliasIds: [aliasId],
		} as UnifiedSession;

		expect(sessionIdsFor(canonicalId, [session])).toEqual([
			canonicalId,
			aliasId,
		]);
		expect(sessionIdsFor(aliasId, [session])).toEqual([
			canonicalId,
			aliasId,
		]);
	});

	test("lists, reads, and deletes files stored under an alias", () => {
		writeAsset(
			aliasId,
			"legacy.csv",
			Buffer.from("name\nAda\n"),
			"Legacy customer export",
		);
		writeAsset(canonicalId, "duplicate.txt", Buffer.from("canonical"));
		writeAsset(aliasId, "duplicate.txt", Buffer.from("legacy"));

		expect(listAssetsAcross([canonicalId, aliasId])).toMatchObject([
			{ path: "duplicate.txt", size: 9 },
			{
				path: "legacy.csv",
				size: 9,
				description: "Legacy customer export",
			},
		]);
		expect(findAssetPath([canonicalId, aliasId], "legacy.csv")?.sessionId).toBe(
			aliasId,
		);

		deleteAssetAcross([canonicalId, aliasId], "duplicate.txt");
		expect(listAssetsAcross([canonicalId, aliasId])).toMatchObject([
			{ path: "legacy.csv" },
		]);
	});

	test("preserves descriptions across rewrites and removes them with files", () => {
		writeAsset(canonicalId, "report.html", Buffer.from("first"), "Q3 report");
		writeAsset(canonicalId, "report.html", Buffer.from("second"));

		expect(listAssetsAcross([canonicalId])).toMatchObject([
			{ path: "report.html", description: "Q3 report" },
		]);

		deleteAssetAcross([canonicalId], "./report.html");
		writeAsset(canonicalId, "report.html", Buffer.from("third"));
		expect(listAssetsAcross([canonicalId])[0]?.description).toBeUndefined();
	});

	test("reserves the description metadata filename", () => {
		expect(() =>
			writeAsset(canonicalId, ".opensession-assets.json", Buffer.from("{}")),
		).toThrow("reserved for asset metadata");
	});

	test("stores descriptions for filenames that overlap object properties", () => {
		writeAsset(canonicalId, "__proto__", Buffer.from("data"), "Prototype report");
		expect(listAssetsAcross([canonicalId])).toMatchObject([
			{ path: "__proto__", description: "Prototype report" },
		]);
	});
});
