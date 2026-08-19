import { afterEach, expect, test } from "bun:test";
import {
	fetchRepos,
	fetchReads,
	fetchSessionsSnapshot,
	newSessionApi,
} from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("read marks load from the current user's API namespace", async () => {
	let url = "";
	globalThis.fetch = (async (input: string | URL | Request) => {
		url = String(input);
		return Response.json({ reads: { "bks-1": "2026-08-11T10:00:00.000Z" } });
	}) as unknown as typeof fetch;

	await expect(fetchReads("Ada Lovelace")).resolves.toEqual({
		"bks-1": "2026-08-11T10:00:00.000Z",
	});
	expect(url).toBe("/api/reads?user=Ada%20Lovelace");
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
			},
		});
	}) as unknown as typeof fetch;

	await expect(
		fetchSessionsSnapshot({ etag: '"sessions-v1"' }),
	).resolves.toEqual({
		text: null,
		etag: '"sessions-v1"',
		notModified: true,
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
	});
});

test("new workspace tabs create an idle sibling session", async () => {
	let url = "";
	let init: RequestInit | undefined;
	globalThis.fetch = (async (
		input: string | URL | Request,
		requestInit?: RequestInit,
	) => {
		url = String(input);
		init = requestInit;
		return Response.json({ id: "bks-new", session: { id: "bks-new" } });
	}) as unknown as typeof fetch;

	const created = await newSessionApi("bks-source", "Kent", "share");
	expect(created.id).toBe("bks-new");
	expect(created.session?.id).toBe("bks-new");
	expect(url).toBe("/api/sessions/bks-source/new-session");
	expect(init?.method).toBe("POST");
	expect(JSON.parse(String(init?.body))).toEqual({ user: "Kent", mode: "share" });
});
