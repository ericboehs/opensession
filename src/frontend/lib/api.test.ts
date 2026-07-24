import { afterEach, expect, test } from "bun:test";
import { SessionUpgradeError, upgradeSessionApi } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("session upgrade accepts a cloud destination when local archival failed", async () => {
	globalThis.fetch = (async () =>
		Response.json(
			{
				id: "bks-cloud",
				url: "https://cloud.example/session/bks-cloud",
				error: "The cloud session was imported, but the local session could not be archived",
			},
			{ status: 500 },
		)) as typeof fetch;

	await expect(upgradeSessionApi("bks-local")).resolves.toEqual({
		id: "bks-cloud",
		url: "https://cloud.example/session/bks-cloud",
	});
});

test("session upgrade keeps structured dirty-worktree failures", async () => {
	globalThis.fetch = (async () =>
		Response.json(
			{
				error: "Commit or discard the worktree changes before upgrading",
				uncommittedFiles: ["src/index.ts", 42],
			},
			{ status: 409 },
		)) as typeof fetch;

	const error = await upgradeSessionApi("bks-local").catch((cause) => cause);
	expect(error).toBeInstanceOf(SessionUpgradeError);
	expect(error).toMatchObject({
		status: 409,
		uncommittedFiles: ["src/index.ts"],
	});
});
