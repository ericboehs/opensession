import { afterEach, describe, expect, test } from "bun:test";
import {
	mergeSessionLists,
	mergedCloudSessions,
	isCloudCreateRequest,
	localSessionOwnsId,
	proxyCloudFrontendRequest,
	proxyCloudSessionRequest,
	proxyCloudTargetRequest,
	resolveCloudIdentity,
	sessionIdFromApiPath,
	sessionRequestTarget,
	shouldProxyCloudTargetRequest,
	shouldProxyCloudFrontendRequest,
	verifiedCloudIdentity,
} from "./cloud-proxy";
import type { UnifiedSession } from "./types";

const ENV_KEYS = [
	"OPENSESSION_PROFILE",
	"OPENSESSION_CLOUD_UPSTREAM",
	"OPENSESSION_CLOUD_TOKEN",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	delete (globalThis as any).__localCloudIdentityState;
	delete (globalThis as any).__localCloudToken;
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
	test("verifies the local owner through the hosted GitHub session", async () => {
		enableCloud();
		let authorization = "";
		const identity = await resolveCloudIdentity(
			(async (_url: string | URL | Request, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("authorization") || "";
				return Response.json({
					required: true,
					authenticated: true,
					login: "jfrolich",
					name: "Jaap Frolich",
				});
			}) as unknown as typeof fetch,
		);
		expect(authorization).toBe("Bearer secret-token");
		expect(identity).toEqual({ login: "jfrolich", name: "Jaap" });
		expect(process.env.OPENSESSION_CLOUD_TOKEN).toBeUndefined();
	});

	test("rejects hosted responses without enabled GitHub auth", async () => {
		enableCloud();
		const identity = await resolveCloudIdentity(
			(async () =>
				Response.json({
					required: false,
					authenticated: true,
					login: "jfrolich",
					name: "Jaap Frolich",
				})) as unknown as typeof fetch,
		);
		expect(identity).toBeNull();
	});

	test("caches verification briefly and then observes revocation", async () => {
		enableCloud();
		process.env.OPENSESSION_CLOUD_TOKEN = "revocation-token";
		let authenticated = true;
		let calls = 0;
		const fetchIdentity = (async () => {
			calls++;
			return Response.json({
				required: true,
				authenticated,
				login: "jfrolich",
				name: "Jaap Frolich",
			});
		}) as unknown as typeof fetch;

		expect(await verifiedCloudIdentity(fetchIdentity)).toEqual({
			login: "jfrolich",
			name: "Jaap",
		});
		authenticated = false;
		expect(await verifiedCloudIdentity(fetchIdentity)).toEqual({
			login: "jfrolich",
			name: "Jaap",
		});
		expect(calls).toBe(1);
		expect(await verifiedCloudIdentity(fetchIdentity, 0)).toBeNull();
		expect(calls).toBe(2);
	});

	test("proxies only local-profile frontend reads", () => {
		process.env.OPENSESSION_PROFILE = "local";
		const request = new Request("http://127.0.0.1:3850/session/bks-1");
		const ctx = {
			req: request,
			path: "/backstage/session/bks-1",
		};
		expect(shouldProxyCloudFrontendRequest(ctx)).toBe(true);
		expect(
			shouldProxyCloudFrontendRequest({
				...ctx,
				path: "/backstage/api/health",
			}),
		).toBe(false);
		expect(
			shouldProxyCloudFrontendRequest({
				...ctx,
				path: "/backstage/ws",
			}),
		).toBe(false);
		expect(
			shouldProxyCloudFrontendRequest({
				...ctx,
				req: new Request(request.url, { method: "POST" }),
			}),
		).toBe(false);
		process.env.OPENSESSION_PROFILE = "cloud";
		expect(shouldProxyCloudFrontendRequest(ctx)).toBe(false);
	});

	test("proxies hosted frontend without a token or local credentials", async () => {
		process.env.OPENSESSION_PROFILE = "local";
		process.env.OPENSESSION_CLOUD_UPSTREAM = "https://cloud.example/";
		delete process.env.OPENSESSION_CLOUD_TOKEN;
		const request = new Request("http://127.0.0.1:3850/session/bks-1?tab=chat", {
			headers: {
				accept: "text/html",
				cookie: "local-session=secret",
				origin: "http://127.0.0.1:3850",
			},
		});
		let seenUrl = "";
		let seenHeaders = new Headers();
		const response = await proxyCloudFrontendRequest(
			{
				req: request,
				url: new URL(request.url),
				path: "/backstage/session/bks-1",
				publicPrefix: "",
			},
			(async (url: string | URL | Request, init?: RequestInit) => {
				seenUrl = String(url);
				seenHeaders = new Headers(init?.headers);
				return new Response("<html>hosted</html>", {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-encoding": "gzip",
						"set-cookie": "cloud-session=secret",
					},
				});
			}) as unknown as typeof fetch,
		);
		expect(seenUrl).toBe("https://cloud.example/session/bks-1?tab=chat");
		expect(seenHeaders.get("accept")).toBe("text/html");
		expect(seenHeaders.get("authorization")).toBeNull();
		expect(seenHeaders.get("cookie")).toBeNull();
		expect(seenHeaders.get("origin")).toBeNull();
		expect(response?.headers.get("content-encoding")).toBeNull();
		expect(response?.headers.get("set-cookie")).toBeNull();
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(await response?.text()).toBe("<html>hosted</html>");
	});

	test("preserves hosted asset caching and reports upstream failure", async () => {
		process.env.OPENSESSION_PROFILE = "local";
		process.env.OPENSESSION_CLOUD_UPSTREAM = "https://cloud.example";
		const request = new Request("http://127.0.0.1:3850/App-abc.js");
		const ctx = {
			req: request,
			url: new URL(request.url),
			path: "/backstage/App-abc.js",
			publicPrefix: "",
		};
		const asset = await proxyCloudFrontendRequest(
			ctx,
			(async () =>
				new Response("js", {
					headers: { "cache-control": "public, max-age=31536000, immutable" },
				})) as unknown as typeof fetch,
		);
		expect(asset?.headers.get("cache-control")).toBe(
			"public, max-age=31536000, immutable",
		);
		const failed = await proxyCloudFrontendRequest(
			ctx,
			(async () => {
				throw new Error("offline");
			}) as unknown as typeof fetch,
		);
		expect(failed?.status).toBe(502);
		expect(failed?.headers.get("cache-control")).toBe("no-store");
	});

	test("keeps hosted redirects on the loopback origin", async () => {
		process.env.OPENSESSION_PROFILE = "local";
		process.env.OPENSESSION_CLOUD_UPSTREAM = "https://cloud.example";
		const request = new Request("http://127.0.0.1:3850/old");
		const ctx = {
			req: request,
			url: new URL(request.url),
			path: "/backstage/old",
			publicPrefix: "",
		};
		const redirect = await proxyCloudFrontendRequest(
			ctx,
			(async () =>
				new Response(null, {
					status: 302,
					headers: {
						location: "https://cloud.example/new?from=old",
						"alt-svc": 'h3=":443"',
					},
				})) as unknown as typeof fetch,
		);
		expect(redirect?.headers.get("location")).toBe("/new?from=old");
		expect(redirect?.headers.get("alt-svc")).toBeNull();
		expect(redirect?.headers.get("cache-control")).toBe("no-store");

		const refused = await proxyCloudFrontendRequest(
			ctx,
			(async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://example.com/elsewhere" },
				})) as unknown as typeof fetch,
		);
		expect(refused?.status).toBe(502);
		expect(refused?.headers.get("location")).toBeNull();
	});

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

	test("only proxies allowlisted cloud-target metadata reads", () => {
		enableCloud();
		const request = new Request("http://127.0.0.1:3850/api/models?cloud=1");
		const ctx = {
			req: request,
			url: new URL(request.url),
			path: "/backstage/api/models",
		};
		expect(shouldProxyCloudTargetRequest(ctx)).toBe(true);
		expect(
			shouldProxyCloudTargetRequest({
				...ctx,
				path: "/backstage/api/automations",
			}),
		).toBe(false);
		expect(
			shouldProxyCloudTargetRequest({
				...ctx,
				req: new Request(request.url, { method: "POST" }),
			}),
		).toBe(false);
	});

	test("proxies cloud-target metadata without leaking its routing query", async () => {
		enableCloud();
		const request = new Request("http://127.0.0.1:3850/api/models?cloud=1&detail=full");
		let seenUrl = "";
		let authorization = "";
		const response = await proxyCloudTargetRequest(
			{
				req: request,
				url: new URL(request.url),
				path: "/backstage/api/models",
				publicPrefix: "",
			},
			(async (url: string | URL | Request, init?: RequestInit) => {
				seenUrl = String(url);
				authorization = new Headers(init?.headers).get("authorization") || "";
				return Response.json({ models: [], default: "dial/medium" });
			}) as unknown as typeof fetch,
		);
		expect(seenUrl).toBe("https://cloud.example/backstage/api/models?detail=full");
		expect(authorization).toBe("Bearer secret-token");
		expect(await response?.json()).toEqual({ models: [], default: "dial/medium" });
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
