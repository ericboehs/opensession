/** Hosted-side virtual WebSocket lanes used by a local-profile cloud proxy. */

import type { WSClientData } from "./ws-hub";

type VirtualClient = {
	data: WSClientData;
	send(payload: string | Uint8Array): number;
};

type DispatchMessage = (client: any, payload: string) => Promise<void> | void;
type DispatchClose = (client: any) => void;

function validLaneId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function lanesFor(ws: any): Map<string, VirtualClient> {
	return (ws.data.cloudProxyLanes ??= new Map());
}

function closeLane(ws: any, laneId: string, dispatchClose: DispatchClose): void {
	const lane = lanesFor(ws).get(laneId);
	if (!lane) return;
	lanesFor(ws).delete(laneId);
	dispatchClose(lane);
}

export async function handleCloudProxyProtocolMessage(
	ws: any,
	message: any,
	dispatchMessage: DispatchMessage,
	dispatchClose: DispatchClose,
): Promise<boolean> {
	if (message.type !== "cloud_proxy_message" && message.type !== "cloud_proxy_close") {
		return false;
	}
	if (!ws.data.cloudProxy || !validLaneId(message.laneId)) {
		try {
			ws.send(JSON.stringify({ type: "error", message: "Cloud proxy protocol denied" }));
		} catch {}
		return true;
	}
	if (message.type === "cloud_proxy_close") {
		closeLane(ws, message.laneId, dispatchClose);
		return true;
	}
	if (!message.message || typeof message.message !== "object") return true;
	if (
		message.message.type === "cloud_proxy_message" ||
		message.message.type === "cloud_proxy_close"
	) {
		return true;
	}
	let lane = lanesFor(ws).get(message.laneId);
	if (!lane) {
		const laneId = message.laneId;
		lane = {
			data: {
				watchingSessionId: null,
				watchingNoteId: null,
				user: ws.data.user || null,
				authUser: ws.data.authUser || null,
				authLogin: ws.data.authLogin || null,
			},
			send(payload) {
				const serialized =
					typeof payload === "string" ? payload : new TextDecoder().decode(payload);
				return ws.send(
					JSON.stringify({
						type: "cloud_proxy_frame",
						laneId,
						payload: serialized,
					}),
				);
			},
		};
		lanesFor(ws).set(laneId, lane);
	}
	await dispatchMessage(lane, JSON.stringify(message.message));
	return true;
}

export function closeCloudProxyProtocol(
	ws: any,
	dispatchClose: DispatchClose,
): void {
	if (!ws.data.cloudProxyLanes) return;
	for (const laneId of Array.from<string>(ws.data.cloudProxyLanes.keys())) {
		closeLane(ws, laneId, dispatchClose);
	}
}
