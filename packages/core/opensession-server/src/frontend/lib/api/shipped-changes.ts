import type { SessionSlackShare } from "../types";
import { request } from "./request";

export function shareShippedChange(
	sessionId: string,
	target: { repo?: string; branch?: string; channel?: string; message?: string; screenshots?: string[] },
): Promise<{ status: "shared" | "already_shared"; share?: SessionSlackShare }> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/share-shipped-change`, {
		method: "POST",
		body: target,
		label: "Couldn't share the shipped update",
	});
}

export function fetchShippedChangeChannels(sessionId: string): Promise<{
	channels: Array<{ id: string; name: string }>;
	defaultChannel?: string;
	canUploadImages?: boolean;
}> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/share-shipped-change`, {
		label: "Couldn't load Slack channels",
	});
}

export async function reconnectSlack(): Promise<void> {
	const popup = window.open("about:blank", "_blank");
	const result = await request<{ url: string }>("/connections/mcp/slack/oauth/start", {
		method: "POST",
		body: { scope: "me" },
		label: "Couldn't reconnect Slack",
	});
	if (popup) popup.location.href = result.url;
	else window.location.href = result.url;
}

export function fetchSlackChannels(sessionId: string): Promise<{
	channels: Array<{ id: string; name: string }>;
	defaultChannel?: string;
	canUploadImages?: boolean;
}> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
		label: "Couldn't load Slack channels",
	});
}

export function openSlackComposer(
	sessionId: string,
	message: string,
): Promise<{ id: string; message: string; channel?: string; images: string[] }> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer/open`, {
		method: "POST",
		body: { message },
		label: "Couldn't open the Slack composer",
	});
}

export function sendSlackComposer(
	sessionId: string,
	target: { requestId: string; channel: string; message: string; screenshots: string[] },
): Promise<{
	status: "sent";
	channel: { id: string; name: string };
	permalink?: string;
}> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
		method: "POST",
		body: target,
		label: "Couldn't send to Slack",
	});
}

export function cancelSlackComposer(sessionId: string, requestId: string): Promise<void> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/slack-composer`, {
		method: "DELETE",
		body: { requestId },
		label: "Couldn't close the Slack composer",
	});
}
