import { describe, expect, test } from "bun:test";
import {
	closeCloudProxyProtocol,
	handleCloudProxyProtocolMessage,
} from "./cloud-proxy-protocol";

function upstreamSocket() {
	const sent: any[] = [];
	return {
		data: {
			cloudProxy: true,
			user: "Ada",
			authUser: "Ada",
			authLogin: "ada",
		},
		sent,
		send(payload: string) {
			sent.push(JSON.parse(payload));
			return payload.length;
		},
	};
}

describe("hosted cloud proxy lanes", () => {
	test("keeps watch and unscoped replies isolated per downstream lane", async () => {
		const ws = upstreamSocket();
		const contexts: string[] = [];
		const dispatch = (lane: any, payload: string) => {
			const message = JSON.parse(payload);
			if (message.type === "watch") lane.data.watchingSessionId = message.sessionId;
			if (message.type === "cancel") contexts.push(lane.data.watchingSessionId);
			lane.send(JSON.stringify({ type: "notice", message: lane.data.watchingSessionId }));
		};
		const close = () => {};

		for (const [laneId, sessionId] of [["lane-a", "session-a"], ["lane-b", "session-b"]]) {
			await handleCloudProxyProtocolMessage(
				ws,
				{ type: "cloud_proxy_message", laneId, message: { type: "watch", sessionId } },
				dispatch,
				close,
			);
		}
		for (const laneId of ["lane-a", "lane-b"]) {
			await handleCloudProxyProtocolMessage(
				ws,
				{ type: "cloud_proxy_message", laneId, message: { type: "cancel" } },
				dispatch,
				close,
			);
		}

		expect(contexts).toEqual(["session-a", "session-b"]);
		expect(ws.sent.map((frame) => [frame.laneId, JSON.parse(frame.payload).message])).toEqual([
			["lane-a", "session-a"],
			["lane-b", "session-b"],
			["lane-a", "session-a"],
			["lane-b", "session-b"],
		]);
	});

	test("closes each virtual lane when its downstream or physical socket closes", async () => {
		const ws = upstreamSocket();
		const closed: string[] = [];
		const dispatch = (lane: any) => {
			lane.data.watchingSessionId = "session-a";
		};
		const close = (lane: any) => closed.push(lane.data.watchingSessionId);
		for (const laneId of ["lane-a", "lane-b"]) {
			await handleCloudProxyProtocolMessage(
				ws,
				{ type: "cloud_proxy_message", laneId, message: { type: "watch" } },
				dispatch,
				close,
			);
		}
		await handleCloudProxyProtocolMessage(
			ws,
			{ type: "cloud_proxy_close", laneId: "lane-a" },
			dispatch,
			close,
		);
		closeCloudProxyProtocol(ws, close);
		expect(closed).toEqual(["session-a", "session-a"]);
	});

	test("denies the lane protocol on an ordinary hosted browser socket", async () => {
		const ws = upstreamSocket();
		ws.data.cloudProxy = false;
		let dispatched = false;
		const handled = await handleCloudProxyProtocolMessage(
			ws,
			{ type: "cloud_proxy_message", laneId: "lane", message: { type: "watch" } },
			() => {
				dispatched = true;
			},
			() => {},
		);
		expect(handled).toBe(true);
		expect(dispatched).toBe(false);
		expect(ws.sent[0].message).toBe("Cloud proxy protocol denied");
	});
});
