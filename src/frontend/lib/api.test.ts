import { afterEach, expect, test } from "bun:test";
import {
	fetchRepos,
	fetchSessionsSnapshot,
	SessionUpgradeError,
	upgradeSessionApi,
} from "./api";

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
		)) as unknown as typeof fetch;

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
		)) as unknown as typeof fetch;

	const error = await upgradeSessionApi("bks-local").catch((cause) => cause);
	expect(error).toBeInstanceOf(SessionUpgradeError);
	expect(error).toMatchObject({
		status: 409,
		uncommittedFiles: ["src/index.ts"],
	});
});

test("repository loading recovers from transient server failures", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		if (calls < 3) {
			return Response.json({ error: "temporarily unavailable" }, { status: 502 });
		}
		return Response.json({
			repos: [
				{
					id: "tella-fusion",
					label: "tella-fusion",
					defaultBranch: "main",
					sharedCheckout: false,
				},
			],
		});
	}) as unknown as typeof fetch;

	await expect(fetchRepos()).resolves.toEqual([
		{
			id: "tella-fusion",
			label: "tella-fusion",
			defaultBranch: "main",
			sharedCheckout: false,
		},
	]);
	expect(calls).toBe(3);
});

test("session snapshots send validators and accept bodyless 304 responses", async () => {
	let requestHeaders: Headers | undefined;
	globalThis.fetch = (async (
		_input: string | URL | Request,
		init?: RequestInit,
	) => {
		requestHeaders = new Headers(init?.headers);
		return new Response(null, {
			status: 304,
			headers: {
				ETag: '"sessions-v1"',
				"X-OpenSession-Cloud-Unreachable": "true",
			},
		});
	}) as unknown as typeof fetch;

	await expect(
		fetchSessionsSnapshot({ etag: '"sessions-v1"' }),
	).resolves.toEqual({
		text: null,
		etag: '"sessions-v1"',
		notModified: true,
		cloudUnreachable: true,
	});
	expect(requestHeaders?.get("If-None-Match")).toBe('"sessions-v1"');
});

test("session snapshots retain response validators on changed data", async () => {
	globalThis.fetch = (async () =>
		new Response('[{"id":"session-1"}]', {
			headers: { ETag: '"sessions-v2"' },
		})) as unknown as typeof fetch;

	await expect(fetchSessionsSnapshot()).resolves.toEqual({
		text: '[{"id":"session-1"}]',
		etag: '"sessions-v2"',
		notModified: false,
		cloudUnreachable: false,
	});
});
