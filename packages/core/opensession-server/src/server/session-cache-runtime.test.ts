import { afterEach, describe, expect, test } from "bun:test";
import { enrichSessionRuntime, invalidateSessionsCache } from "./session-cache";
import type { UnifiedSession } from "./types";
import { allClients } from "./ws-hub";

const sockets = new Set<any>();

afterEach(() => {
	for (const socket of sockets) allClients.delete(socket);
	sockets.clear();
});

test("session cache invalidation notifies connected list clients", () => {
	const sent: string[] = [];
	const socket = {
		data: { watchingSessionId: null, user: "Ada" },
		send(payload: string) {
			sent.push(payload);
		},
	};
	sockets.add(socket);
	allClients.add(socket);

	invalidateSessionsCache();

	expect(sent.map((payload) => JSON.parse(payload))).toEqual([
		{ type: "sessions_invalidated" },
	]);
});

describe("session runtime enrichment", () => {
	test("clears stale indexed running state after the runtime settles", () => {
		const session = {
			id: "stale-indexed-runtime-test",
			isRunning: true,
			runStartedAt: "2026-08-22T12:00:00.000Z",
		} as UnifiedSession;

		enrichSessionRuntime([session]);

		expect(session.isRunning).toBe(false);
		expect(session.runStartedAt).toBeUndefined();
	});
});
