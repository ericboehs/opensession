import { describe, expect, test } from "bun:test";
import { isMacReleaseAsset } from "./os1-update";

describe("isMacReleaseAsset", () => {
	test("accepts the current artifactName", () => {
		expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.zip")).toBe(true);
	});

	// Renaming the app renamed the asset. The feed serves whatever the latest
	// release carries, so until a release ships under the new name the newest
	// asset is still an OS1-* one.
	test("still accepts assets published before the rename", () => {
		expect(isMacReleaseAsset("OS1-0.3.12-arm64.zip")).toBe(true);
	});

	test("rejects the other assets a release carries", () => {
		expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.dmg")).toBe(false);
		expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.zip.blockmap")).toBe(false);
		expect(isMacReleaseAsset("os1-chrome-v0.1.0.crx")).toBe(false);
		expect(isMacReleaseAsset("OpenSession-0.3.12-x64.zip")).toBe(false);
		expect(isMacReleaseAsset(undefined)).toBe(false);
	});
});
