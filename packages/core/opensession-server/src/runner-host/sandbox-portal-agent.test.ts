import { expect, test } from "bun:test";
import { loopbackHeaders, openWebSocket, relayRetryDelayMs, sendWebSocket, type PortalSocketState } from "./sandbox-portal-agent";

test("uses local-dev host semantics and disables upstream compression", () => {
	const headers = loopbackHeaders({ host: "portal.example:22000", "accept-encoding": "gzip, br", cookie: "session=abc" }, 4300);
	expect(headers.get("host")).toBe("localhost:4300");
	expect(headers.get("accept-encoding")).toBe("identity");
	expect(headers.get("cookie")).toBe("session=abc");
});

test("backs stale relay credentials off instead of flooding public ingress", () => {
	expect([0, 1, 2, 3, 4, 5, 20].map(relayRetryDelayMs)).toEqual([
		1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
	]);
});

class FakeWebSocket extends EventTarget {
	readyState: number = WebSocket.CONNECTING;
	readonly sent: Array<string | Buffer> = [];

	send(data: string | Buffer): void {
		if (this.readyState !== WebSocket.OPEN) throw new Error("socket is not open");
		this.sent.push(data);
	}

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}
}

test("queues immediate WebSocket frames until the loopback socket opens", () => {
	const relay = { send() {} } as unknown as WebSocket;
	const local = new FakeWebSocket();
	const sockets = new Map<string, PortalSocketState>();

	openWebSocket(relay, sockets, { id: "socket-1", path: "/events" }, 4300, () => local as unknown as WebSocket);
	sendWebSocket(sockets, { id: "socket-1", data: "first" });
	sendWebSocket(sockets, { id: "socket-1", data: "second" });

	expect(local.sent).toEqual([]);
	local.open();
	expect(local.sent).toEqual(["first", "second"]);
});

test("ignores close events from a replaced loopback socket", () => {
	const relayMessages: string[] = [];
	const relay = { send(message: string) { relayMessages.push(message); } } as unknown as WebSocket;
	const first = new FakeWebSocket();
	const replacement = new FakeWebSocket();
	const locals = [first, replacement];
	const sockets = new Map<string, PortalSocketState>();

	openWebSocket(relay, sockets, { id: "socket-1", path: "/first" }, 4300, () => locals.shift()! as unknown as WebSocket);
	openWebSocket(relay, sockets, { id: "socket-1", path: "/replacement" }, 4300, () => locals.shift()! as unknown as WebSocket);
	first.close();

	expect(sockets.get("socket-1")?.socket).toBe(replacement as unknown as WebSocket);
	expect(relayMessages).toEqual([]);
	replacement.close();
	expect(sockets.has("socket-1")).toBe(false);
	expect(relayMessages).toEqual([JSON.stringify({ t: "ws_closed", id: "socket-1" })]);
});
