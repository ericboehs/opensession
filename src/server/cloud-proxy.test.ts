import { afterEach, describe, expect, test } from "bun:test";
import {
	mergeSessionLists,
	mergedCloudSessions,
	isCloudCreateRequest,
	localSessionOwnsId,
	proxyCloudSessionRequest,
	sessionIdFromApiPath,
	sessionRequestTarget,
} from "./cloud-proxy";
import type { UnifiedSession } from "./types";

const ENV_KEYS = [
	"OPENSESSION_PROFILE",
	"OPENSESSION_CLOUD_UPSTREAM",
	"OPENSESSION_CLOUD_TOKEN",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function session(id: string, lastActivity: string): UnifiedSession {
	return {
		id,
		claudeSessionId: null,
		source: "backstage",
		branch: null,
		worktreeDir: null,
		startedBy: null,
		title: id,
		lastActivity,
		createdAt: lastActivity,
		isRunning: false,
		transcriptPath: null,
	};
}

function enableCloud(): void {
	process.env.OPENSESSION_PROFILE = "local";
	process.env.OPENSESSION_CLOUD_UPSTREAM = "https://cloud.example/";
	process.env.OPENSESSION_CLOUD_TOKEN = "secret-token";
}

describe("local cloud session merge", () => {
	test("keeps local ids authoritative, tags them, and sorts the merged view", () => {
		const merged = mergeSessionLists(
			[session("same", "2026-07-20T00:00:00.000Z")],
			[
				session("same", "2026-07-22T00:00:00.000Z"),
				session("cloud", "2026-07-21T00:00:00.000Z"),
			],
		);
		expect(merged.map((item) => item.id)).toEqual(["cloud", "same"]);
		expect(merged.find((item) => item.id === "same")?.local).toBe(true);
		expect(merged.find((item) => item.id === "cloud")?.local).toBeUndefined();
	});

	test("lets a same-id cloud successor replace an upgraded local tombstone", () => {
		const tombstone = {
			...session("same", "2026-07-20T00:00:00.000Z"),
			upgradedTo: { id: "same", url: "https://cloud.example/session/same" },
		};
		const merged = mergeSessionLists(
			[tombstone],
			[session("same", "2026-07-22T00:00:00.000Z")],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].id).toBe("same");
		expect(merged[0].local).toBeUndefined();
		expect(localSessionOwnsId(tombstone)).toBe(false);
	});

	test("does no upstream work without a configured token", async () => {
		process.env.OPENSESSION_PROFILE = "local";
		delete process.env.OPENSESSION_CLOUD_TOKEN;
		let calls = 0;
		const result = await mergedCloudSessions([session("local", "2026-07-22T00:00:00Z")],
			(async () => {
				calls++;
				throw new Error("must not be called");
			}) as unknown as typeof fetch,
		);
		expect(calls).toBe(0);
		expect(result.cloudUnreachable).toBe(false);
		expect(result.sessions[0].local).toBe(true);
	});

	test("uses bearer auth and degrades to local sessions when upstream fails", async () => {
		enableCloud();
		let authorization = "";
		const result = await mergedCloudSessions(
			[session("local", "2026-07-22T00:00:00Z")],
			(async (_url: string | URL | Request, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("authorization") || "";
				throw new Error("offline");
			}) as unknown as typeof fetch,
		);
		expect(authorization).toBe("Bearer secret-token");
		expect(result.cloudUnreachable).toBe(true);
		expect(result.sessions.map((item) => item.id)).toEqual(["local"]);
	});

	test("leaves the cloud-profile list byte-identical without fetching", async () => {
		process.env.OPENSESSION_PROFILE = "cloud";
		process.env.OPENSESSION_CLOUD_TOKEN = "configured-but-dormant";
		const input = [session("hosted", "2026-07-22T00:00:00Z")];
		let calls = 0;
		const result = await mergedCloudSessions(input, (async () => {
			calls++;
			throw new Error("must not fetch");
		}) as unknown as typeof fetch);
		expect(calls).toBe(0);
		expect(result.sessions).toBe(input);
		expect(result.sessions[0].local).toBeUndefined();
	});

	test("merges a successful mocked upstream response", async () => {
		enableCloud();
		const result = await mergedCloudSessions(
			[session("local", "2026-07-20T00:00:00Z")],
			(async () =>
				Response.json([session("cloud", "2026-07-22T00:00:00Z")])) as unknown as typeof fetch,
		);
		expect(result.cloudUnreachable).toBe(false);
		expect(result.sessions.map((item) => item.id)).toEqual(["cloud", "local"]);
	});
});

describe("local cloud request routing", () => {
	test("only marks explicit local-profile creates for the cloud", () => {
		const message = { type: "create_session", cloud: true };
		expect(isCloudCreateRequest(message, true)).toBe(true);
		expect(isCloudCreateRequest(message, false)).toBe(false);
		expect(isCloudCreateRequest({ type: "create_session" }, true)).toBe(false);
	});

	test("extracts normalized session API ids only", () => {
		expect(sessionIdFromApiPath("/backstage/api/sessions/cloud%2Fid/transcript")).toBe("cloud/id");
		expect(sessionIdFromApiPath("/backstage/api/sessions")).toBeNull();
		expect(sessionIdFromApiPath("/backstage/api/models")).toBeNull();
		for (const literal of ["search", "archive-old", "import"]) {
			expect(sessionIdFromApiPath(`/backstage/api/sessions/${literal}`)).toBeNull();
		}
	});

	test("routes local ids locally and non-local ids to configured cloud", () => {
		const path = "/backstage/api/sessions/bks-cloud/diff";
		expect(sessionRequestTarget(path, true, true)).toBe("local");
		expect(sessionRequestTarget(path, false, true)).toBe("cloud");
		expect(sessionRequestTarget(path, false, false)).toBe("local");
		expect(sessionRequestTarget("/backstage/api/models", false, true)).toBe("none");
	});

	test("proxies method, query, body and bearer to the upstream", async () => {
		enableCloud();
		let seen: { url?: string; method?: string; authorization?: string; body?: string } = {};
		const request = new Request("http://127.0.0.1:3850/api/sessions/cloud/pr-action?repo=app", {
			method: "POST",
			headers: { cookie: "local=1", "content-type": "application/json" },
			body: '{"action":"ready"}',
		});
		const response = await proxyCloudSessionRequest(
			{
				req: request,
				url: new URL(request.url),
				path: "/backstage/api/sessions/cloud/pr-action",
				publicPrefix: "",
			},
			(async (url: string | URL | Request, init?: RequestInit) => {
				seen = {
					url: String(url),
					method: init?.method,
					authorization: new Headers(init?.headers).get("authorization") || undefined,
					body: init?.body ? await new Response(init.body).text() : undefined,
				};
				return new Response("proxied", { status: 202, headers: { "content-encoding": "gzip" } });
			}) as unknown as typeof fetch,
			() => false,
		);
		expect(seen).toEqual({
			url: "https://cloud.example/backstage/api/sessions/cloud/pr-action?repo=app",
			method: "POST",
			authorization: "Bearer secret-token",
			body: '{"action":"ready"}',
		});
		expect(response?.status).toBe(202);
		expect(response?.headers.get("content-encoding")).toBeNull();
		expect(await response?.text()).toBe("proxied");
	});
});
