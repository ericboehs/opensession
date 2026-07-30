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
		writeAsset(aliasId, "legacy.csv", Buffer.from("name\nAda\n"));
		writeAsset(canonicalId, "duplicate.txt", Buffer.from("canonical"));
		writeAsset(aliasId, "duplicate.txt", Buffer.from("legacy"));

		expect(listAssetsAcross([canonicalId, aliasId])).toMatchObject([
			{ path: "duplicate.txt", size: 9 },
			{ path: "legacy.csv", size: 9 },
		]);
		expect(findAssetPath([canonicalId, aliasId], "legacy.csv")?.sessionId).toBe(
			aliasId,
		);

		deleteAssetAcross([canonicalId, aliasId], "duplicate.txt");
		expect(listAssetsAcross([canonicalId, aliasId])).toMatchObject([
			{ path: "legacy.csv" },
		]);
	});
});
