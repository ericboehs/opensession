/**
 * Local-profile bridge to a hosted OpenSession instance. HTTP requests are
 * routed by session ownership; one lazy upstream WebSocket carries isolated
 * virtual-client lanes for every local browser socket.
 */

import type { ServerWebSocket } from "bun";
import { configuredCloud } from "./config";
import { stopAllWatchesForClient } from "./file-watcher";
import { isLocalProfile } from "./profile";
import type { LocalProfileIdentity } from "./profile";
import type { RouteContext } from "./routes/context";
import { findSession } from "./session-cache";
import type { UnifiedSession } from "./types";
import { leaveSession, type WSClientData } from "./ws-hub";

const LIST_TIMEOUT_MS = 3_000;
const IDENTITY_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_INITIAL_QUEUE = 100;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const COLLECTION_ROUTES = new Set(["search", "archive-old", "import"]);
const CLOUD_TARGET_GET_ROUTES = new Set([
	"/backstage/api/models",
	"/backstage/api/repos",
	"/backstage/api/claude-accounts",
	"/backstage/api/codex-accounts",
]);

type Client = ServerWebSocket<WSClientData>;
type Outbound = { laneId: string; payload: string };

interface CloudSocketState {
	socket: WebSocket | null;
	status: "idle" | "connecting" | "open";
	reconnectAttempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	connectTimer: ReturnType<typeof setTimeout> | null;
	everOpened: boolean;
	initialQueue: Outbound[];
	lanes: Map<string, Client>;
}

function freshSocketState(): CloudSocketState {
	return {
		socket: null,
		status: "idle",
		reconnectAttempt: 0,
		reconnectTimer: null,
		connectTimer: null,
		everOpened: false,
		initialQueue: [],
		lanes: new Map(),
	};
}

const g = globalThis as any;
type IdentityState = {
	token: string;
	checkedAt: number;
	identity: LocalProfileIdentity | null;
	pending?: Promise<LocalProfileIdentity | null>;
};
const previousSocketState = g.__localCloudSocketState as CloudSocketState | undefined;
if (!previousSocketState?.lanes) {
	try {
		previousSocketState?.socket?.close();
	} catch {}
	if (previousSocketState?.reconnectTimer) {
		clearTimeout(previousSocketState.reconnectTimer);
	}
}
const socketState: CloudSocketState = previousSocketState?.lanes
	? previousSocketState
	: freshSocketState();
g.__localCloudSocketState = socketState;

function cloudToken(): string | null {
	if (!isLocalProfile()) return configuredCloud().token;
	if (g.__localCloudToken === undefined) {
		g.__localCloudToken = configuredCloud().token || null;
		delete process.env.OPENSESSION_CLOUD_TOKEN;
	}
	return g.__localCloudToken;
}

export function configuredCloudAccess(): ReturnType<typeof configuredCloud> {
	return { ...configuredCloud(), token: cloudToken() };
}

function cloudEnabled(): boolean {
	return isLocalProfile() && !!cloudToken();
}

/** Resolve the local process owner through the hosted GitHub web session. */
export async function resolveCloudIdentity(
	fetchImpl: typeof fetch = fetch,
): Promise<LocalProfileIdentity | null> {
	if (!isLocalProfile() || !cloudToken()) return null;
	try {
		const response = await fetchImpl(upstreamUrl("/backstage/api/auth/status"), {
			headers: proxyHeaders(new Headers()),
			signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const body = await response.json();
		return body?.required === true &&
			body.authenticated === true &&
			typeof body.login === "string" &&
			body.login.trim() &&
			typeof body.name === "string" &&
			body.name.trim()
			? { login: body.login.trim(), name: body.name.trim().split(" ")[0] }
			: null;
	} catch (error) {
		console.warn("[cloud-proxy] identity verification failed:", error);
		return null;
	}
}

export async function verifiedCloudIdentity(
	fetchImpl: typeof fetch = fetch,
	maxAgeMs = IDENTITY_TTL_MS,
): Promise<LocalProfileIdentity | null> {
	const token = cloudToken() || "";
	const cached = g.__localCloudIdentityState as IdentityState | undefined;
	if (
		cached &&
		cached.token === token &&
		Date.now() - cached.checkedAt < maxAgeMs
	) {
		return cached.identity;
	}
	if (cached?.token === token && cached.pending) return cached.pending;
	const state: IdentityState = {
		token,
		checkedAt: cached?.checkedAt || 0,
		identity: cached?.identity || null,
	};
	state.pending = resolveCloudIdentity(fetchImpl).then((identity) => {
		if (g.__localCloudIdentityState === state) {
			state.identity = identity;
			state.checkedAt = Date.now();
			delete state.pending;
		}
		return identity;
	});
	g.__localCloudIdentityState = state;
	return state.pending;
}

export function isCloudCreateRequest(message: any, localProfile = isLocalProfile()): boolean {
	return (
		localProfile &&
		message?.type === "create_session" &&
		message.cloud === true
	);
}

function upstreamUrl(path: string): string {
	const base = configuredCloud().upstream.replace(/\/+$/, "");
	return `${base}${path}`;
}

function websocketUpstream(): string {
	const url = new URL(upstreamUrl("/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function sendClient(client: Client, message: object | string): void {
	try {
		client.send(typeof message === "string" ? message : JSON.stringify(message));
	} catch {}
}

export function localSessionOwnsId(session: UnifiedSession | undefined): boolean {
	return !!session && !(session as UnifiedSession & { upgradedTo?: unknown }).upgradedTo;
}

export function sessionIdFromApiPath(path: string): string | null {
	const match = path.match(/^\/backstage\/api\/sessions\/([^/]+)(?:\/|$)/);
	if (!match || COLLECTION_ROUTES.has(match[1])) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

export function shouldProxySessionRequest(
	path: string,
	localSessionExists: (sessionId: string) => boolean = (sessionId) =>
		localSessionOwnsId(findSession(sessionId)),
): boolean {
	const sessionId = sessionIdFromApiPath(path);
	return sessionRequestTarget(
		path,
		!!sessionId && localSessionExists(sessionId),
		cloudEnabled(),
	) === "cloud";
}

export function sessionRequestTarget(
	path: string,
	isLocalSession: boolean,
	cloudConfigured: boolean,
): "none" | "local" | "cloud" {
	if (!sessionIdFromApiPath(path)) return "none";
	if (isLocalSession) return "local";
	return cloudConfigured ? "cloud" : "local";
}

function proxyHeaders(source: Headers): Headers {
	const headers = new Headers(source);
	const token = cloudToken();
	if (token) headers.set("authorization", `Bearer ${token}`);
	headers.delete("host");
	headers.delete("cookie");
	return headers;
}

function responseWithoutStaleEncoding(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function shouldProxyCloudFrontendRequest(
	ctx: Pick<RouteContext, "path" | "req">,
): boolean {
	if (!isLocalProfile() || (ctx.req.method !== "GET" && ctx.req.method !== "HEAD")) {
		return false;
	}
	return !(
		ctx.path === "/backstage/api" ||
		ctx.path.startsWith("/backstage/api/") ||
		ctx.path === "/backstage/ws" ||
		ctx.path === "/backstage/rpc-ws" ||
		ctx.path === "/backstage/run-ws" ||
		ctx.path.startsWith("/backstage/run-ws/")
	);
}

function frontendProxyHeaders(source: Headers): Headers {
	const headers = new Headers();
	for (const name of [
		"accept",
		"accept-language",
		"accept-encoding",
		"if-none-match",
		"if-modified-since",
		"if-range",
		"range",
	]) {
		const value = source.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

function cloudFrontendResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.delete("set-cookie");
	for (const name of [
		"alt-svc",
		"clear-site-data",
		"nel",
		"report-to",
		"strict-transport-security",
	]) {
		headers.delete(name);
	}
	const location = headers.get("location");
	if (location) {
		const upstream = new URL(configuredCloud().upstream);
		const target = new URL(location, upstream);
		if (target.origin !== upstream.origin) {
			return new Response("Cloud frontend refused a cross-origin redirect", {
				status: 502,
				headers: { "Cache-Control": "no-store" },
			});
		}
		headers.set("location", target.pathname + target.search + target.hash);
		headers.set("cache-control", "no-store");
	}
	if (headers.get("content-type")?.includes("text/html")) {
		headers.set("cache-control", "no-store");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Serve the hosted app shell from the loopback origin so its API/WS stay local. */
export async function proxyCloudFrontendRequest(
	ctx: RouteContext,
	fetchImpl: typeof fetch = fetch,
): Promise<Response | undefined> {
	if (!shouldProxyCloudFrontendRequest(ctx)) return undefined;
	try {
		const response = await fetchImpl(
			upstreamUrl(ctx.url.pathname + ctx.url.search),
			{
				method: ctx.req.method,
				headers: frontendProxyHeaders(ctx.req.headers),
				redirect: "manual",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		return cloudFrontendResponse(response);
	} catch (error) {
		console.warn("[cloud-proxy] frontend request failed:", error);
		return new Response("Cloud OpenSession frontend is unreachable", {
			status: 502,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			},
		});
	}
}

export async function proxyCloudSessionRequest(
	ctx: RouteContext,
	fetchImpl: typeof fetch = fetch,
	localSessionExists?: (sessionId: string) => boolean,
): Promise<Response | undefined> {
	if (!shouldProxySessionRequest(ctx.path, localSessionExists)) return undefined;
	try {
		const response = await fetchImpl(upstreamUrl(ctx.path + ctx.url.search), {
			method: ctx.req.method,
			headers: proxyHeaders(ctx.req.headers),
			body:
				ctx.req.method === "GET" || ctx.req.method === "HEAD"
					? undefined
					: ctx.req.body,
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			// @ts-expect-error streaming request bodies need half-duplex
			duplex: "half",
		});
		return responseWithoutStaleEncoding(response);
	} catch (error) {
		console.warn("[cloud-proxy] session request failed:", error);
		return Response.json(
			{ error: "Cloud OpenSession is unreachable" },
			{ status: 502 },
		);
	}
}

export function shouldProxyCloudTargetRequest(
	ctx: Pick<RouteContext, "path" | "req" | "url">,
): boolean {
	return (
		isLocalProfile() &&
		ctx.req.method === "GET" &&
		ctx.url.searchParams.get("cloud") === "1" &&
		CLOUD_TARGET_GET_ROUTES.has(ctx.path)
	);
}

/** Read cloud-owned session-creation metadata from a local-profile UI. */
export async function proxyCloudTargetRequest(
	ctx: RouteContext,
	fetchImpl: typeof fetch = fetch,
): Promise<Response | undefined> {
	if (!shouldProxyCloudTargetRequest(ctx)) return undefined;
	if (!cloudEnabled()) {
		return Response.json(
			{ error: "Cloud OpenSession is not configured" },
			{ status: 502 },
		);
	}
	const search = new URLSearchParams(ctx.url.searchParams);
	search.delete("cloud");
	const suffix = search.size ? `?${search}` : "";
	try {
		const response = await fetchImpl(upstreamUrl(ctx.path + suffix), {
			headers: proxyHeaders(ctx.req.headers),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return responseWithoutStaleEncoding(response);
	} catch (error) {
		console.warn("[cloud-proxy] target metadata request failed:", error);
		return Response.json(
			{ error: "Cloud OpenSession is unreachable" },
			{ status: 502 },
		);
	}
}

export function mergeSessionLists(
	localSessions: UnifiedSession[],
	cloudSessions: UnifiedSession[],
): UnifiedSession[] {
	const cloudIds = new Set(cloudSessions.map((session) => session.id));
	const local = localSessions
		.filter(
			(session) =>
				!(session as UnifiedSession & { upgradedTo?: unknown }).upgradedTo ||
				!cloudIds.has(session.id),
		)
		.map((session) => ({ ...session, local: true as const }));
	const localIds = new Set(local.map((session) => session.id));
	const cloud = cloudSessions.filter((session) => !localIds.has(session.id));
	return [...local, ...cloud].sort((a, b) =>
		b.lastActivity.localeCompare(a.lastActivity),
	);
}

export async function mergedCloudSessions(
	localSessions: UnifiedSession[],
	fetchImpl: typeof fetch = fetch,
): Promise<{ sessions: UnifiedSession[]; cloudUnreachable: boolean }> {
	if (!isLocalProfile()) {
		return { sessions: localSessions, cloudUnreachable: false };
	}
	if (!cloudEnabled()) {
		return { sessions: mergeSessionLists(localSessions, []), cloudUnreachable: false };
	}
	try {
		const response = await fetchImpl(upstreamUrl("/backstage/api/sessions"), {
			headers: proxyHeaders(new Headers()),
			signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`upstream returned ${response.status}`);
		const cloud = await response.json();
		if (!Array.isArray(cloud)) throw new Error("upstream returned a non-array session list");
		return {
			sessions: mergeSessionLists(localSessions, cloud as UnifiedSession[]),
			cloudUnreachable: false,
		};
	} catch (error) {
		console.warn("[cloud-proxy] session list unavailable:", error);
		return {
			sessions: mergeSessionLists(localSessions, []),
			cloudUnreachable: true,
		};
	}
}

function laneIdFor(client: Client): string {
	const laneId = client.data.cloudLaneId || crypto.randomUUID();
	client.data.cloudLaneId = laneId;
	socketState.lanes.set(laneId, client);
	return laneId;
}

function envelope(laneId: string, message: any): string {
	return JSON.stringify({ type: "cloud_proxy_message", laneId, message });
}

function relayUpstreamMessage(raw: unknown): void {
	let frame: any;
	try {
		frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
	} catch {
		return;
	}
	if (frame.type !== "cloud_proxy_frame" || typeof frame.laneId !== "string") return;
	const client = socketState.lanes.get(frame.laneId);
	if (!client || typeof frame.payload !== "string") return;
	sendClient(client, frame.payload);
}

function clearConnectTimer(): void {
	if (!socketState.connectTimer) return;
	clearTimeout(socketState.connectTimer);
	socketState.connectTimer = null;
}

function scheduleReconnect(): void {
	if (!cloudEnabled() || socketState.reconnectTimer || socketState.lanes.size === 0) return;
	const index = Math.min(socketState.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
	const delay = RECONNECT_DELAYS_MS[index];
	socketState.reconnectAttempt = Math.min(index + 1, RECONNECT_DELAYS_MS.length - 1);
	socketState.reconnectTimer = setTimeout(() => {
		socketState.reconnectTimer = null;
		connectUpstream();
	}, delay);
}

function connectUpstream(): void {
	if (!cloudEnabled() || socketState.status !== "idle" || socketState.lanes.size === 0) return;
	socketState.status = "connecting";
	const token = cloudToken()!;
	let socket: WebSocket;
	try {
		socket = new WebSocket(websocketUpstream(), {
			// @ts-expect-error Bun's WebSocket client supports custom headers.
			headers: {
				authorization: `Bearer ${token}`,
				"x-opensession-cloud-proxy": "1",
			},
		});
	} catch (error) {
		console.warn("[cloud-proxy] WebSocket connect failed:", error);
		socketState.status = "idle";
		scheduleReconnect();
		return;
	}
	socketState.socket = socket;
	socketState.connectTimer = setTimeout(() => {
		if (socketState.socket !== socket || socketState.status !== "connecting") return;
		console.warn("[cloud-proxy] WebSocket handshake timed out");
		try {
			socket.close();
		} catch {}
		if (socketState.socket === socket) {
			socketState.socket = null;
			socketState.status = "idle";
			scheduleReconnect();
		}
	}, CONNECT_TIMEOUT_MS);
	socket.addEventListener("open", () => {
		if (socketState.socket !== socket) return;
		clearConnectTimer();
		socketState.status = "open";
		socketState.everOpened = true;
		socketState.reconnectAttempt = 0;
		for (const [laneId, client] of socketState.lanes) {
			if (client.data.cloudWatchingSessionId) {
				socket.send(
					envelope(laneId, {
						type: "watch",
						sessionId: client.data.cloudWatchingSessionId,
					}),
				);
			}
			if (client.data.cloudTermIds?.size) {
				for (const termId of client.data.cloudTermIds)
					sendClient(client, { type: "term_exit", termId });
				client.data.cloudTermIds = null;
			}
		}
		for (const item of socketState.initialQueue.splice(0)) {
			if (!socketState.lanes.has(item.laneId)) continue;
			try {
				socket.send(item.payload);
			} catch {
				const client = socketState.lanes.get(item.laneId);
				if (client) {
					sendClient(client, {
						type: "error",
						message: "Cloud OpenSession disconnected before the message was sent",
					});
				}
			}
		}
	});
	socket.addEventListener("message", (event) => relayUpstreamMessage(event.data));
	socket.addEventListener("close", () => {
		if (socketState.socket !== socket) return;
		clearConnectTimer();
		socketState.socket = null;
		socketState.status = "idle";
		for (const client of socketState.lanes.values()) {
			if (client.data.cloudTermIds?.size) {
				for (const termId of client.data.cloudTermIds)
					sendClient(client, { type: "term_exit", termId });
				client.data.cloudTermIds = null;
			}
		}
		scheduleReconnect();
	});
	socket.addEventListener("error", () => {
		if (socketState.socket === socket) socket.close();
	});
}

function forwardUpstream(client: Client, message: any): void {
	const laneId = laneIdFor(client);
	const payload = envelope(laneId, message);
	if (socketState.status === "open" && socketState.socket) {
		try {
			socketState.socket.send(payload);
			return;
		} catch {}
	}
	if (!socketState.everOpened && socketState.initialQueue.length < MAX_INITIAL_QUEUE) {
		socketState.initialQueue.push({ laneId, payload });
		connectUpstream();
		return;
	}
	sendClient(client, {
		type: "error",
		sessionId: message.sessionId,
		message: "Cloud OpenSession is reconnecting; this message was not sent",
	});
	scheduleReconnect();
}

function forwardWatch(client: Client, message: any): void {
	const laneId = laneIdFor(client);
	if (socketState.status === "open" && socketState.socket) {
		try {
			socketState.socket.send(envelope(laneId, message));
			return;
		} catch {}
	}
	connectUpstream();
}

function stopCloudWatch(client: Client): void {
	if (!client.data.cloudWatchingSessionId) return;
	forwardUpstream(client, {
		type: "unwatch",
		sessionId: client.data.cloudWatchingSessionId,
	});
	client.data.cloudWatchingSessionId = null;
}

const EXPLICIT_SESSION_MESSAGES = new Set([
	"load_history",
	"prompt",
	"interrupt_prompt",
	"update_queued_prompt",
	"delete_queued_prompt",
	"steer_queued_prompt",
	"interrupt_queued_prompt",
	"reorder_queued_prompt",
	"answer_question",
	"term_start",
]);

/** Return true when a local-profile UI message belongs to a cloud lane. */
export function routeCloudWebSocketMessage(client: Client, message: any): boolean {
	if (isCloudCreateRequest(message)) {
		if (!cloudEnabled()) {
			sendClient(client, {
				type: "error",
				message: "Cloud OpenSession is not configured",
			});
			return true;
		}
		const { cloud: _cloud, ...upstreamMessage } = message;
		forwardUpstream(client, upstreamMessage);
		return true;
	}
	if (!cloudEnabled()) return false;
	if (message.type === "watch" && typeof message.sessionId === "string") {
		if (localSessionOwnsId(findSession(message.sessionId))) {
			stopCloudWatch(client);
			return false;
		}
		stopAllWatchesForClient(client);
		leaveSession(client);
		client.data.cloudWatchingSessionId = message.sessionId;
		forwardWatch(client, message);
		return true;
	}
	if (message.type === "unwatch" && client.data.cloudWatchingSessionId) {
		stopCloudWatch(client);
		return true;
	}
	if (message.type === "cancel" && client.data.cloudWatchingSessionId) {
		forwardUpstream(client, message);
		return true;
	}
	if (EXPLICIT_SESSION_MESSAGES.has(message.type) && typeof message.sessionId === "string") {
		if (localSessionOwnsId(findSession(message.sessionId))) {
			if (message.type === "term_start") {
				const termId =
					typeof message.termId === "string" ? message.termId : "0";
				if (client.data.cloudTermIds?.has(termId)) {
					forwardUpstream(client, { type: "term_stop", termId });
					client.data.cloudTermIds.delete(termId);
				}
			}
			return false;
		}
		if (message.type === "term_start") {
			const termId = typeof message.termId === "string" ? message.termId : "0";
			(client.data.cloudTermIds ??= new Set()).add(termId);
		}
		forwardUpstream(client, message);
		return true;
	}
	if (
		(message.type === "term_input" ||
			message.type === "term_resize" ||
			message.type === "term_stop") &&
		client.data.cloudTermIds?.size
	) {
		forwardUpstream(client, message);
		if (message.type === "term_stop")
			client.data.cloudTermIds.delete(
				typeof message.termId === "string" ? message.termId : "0",
			);
		return true;
	}
	return false;
}

export function cloudWebSocketClientClosed(client: Client): void {
	const laneId = client.data.cloudLaneId;
	if (!laneId) return;
	if (socketState.status === "open") {
		try {
			socketState.socket?.send(JSON.stringify({ type: "cloud_proxy_close", laneId }));
		} catch {}
	}
	socketState.initialQueue = socketState.initialQueue.filter(
		(item) => item.laneId !== laneId,
	);
	socketState.lanes.delete(laneId);
	client.data.cloudLaneId = null;
	client.data.cloudWatchingSessionId = null;
	client.data.cloudTermIds = null;
	if (socketState.lanes.size > 0) return;
	if (socketState.reconnectTimer) clearTimeout(socketState.reconnectTimer);
	socketState.reconnectTimer = null;
	clearConnectTimer();
	try {
		socketState.socket?.close();
	} catch {}
	socketState.socket = null;
	socketState.status = "idle";
	socketState.reconnectAttempt = 0;
	socketState.everOpened = false;
}
