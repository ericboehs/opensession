import { request } from "./request";

export type IngressExposure = "tailscale" | "cloudflare" | "custom";

export interface PublicIngressSettings {
	canManage: boolean;
	publicBaseUrl: string;
	exposure: IngressExposure | null;
	health: "ready" | "waiting_dns" | "unreachable" | "not_configured";
	localUrl: string;
	hostname: string;
	server: { ipv4: string[]; ipv6: string[] };
	dns: { a: string[]; aaaa: string[]; suggested: string[] };
	tailscale: { installed: boolean; dnsName: string; suggestedUrl: string };
	cloudflare: {
		installed: boolean;
		tunnelId: string;
		cnameTarget: string;
		connectorTarget: string;
		tokenConfigured: boolean;
		connectorRunning: boolean;
	};
	custom: { caddyInstalled: boolean; generatedConfig: string };
}

export function fetchPublicIngress(): Promise<PublicIngressSettings> {
	return request("/ingress", { label: "Failed to load public ingress" });
}

export function savePublicIngress(input: {
	publicBaseUrl: string;
	exposure: IngressExposure;
	cloudflareTunnelId?: string;
}): Promise<PublicIngressSettings> {
	return request("/ingress", {
		method: "PUT",
		body: input,
		label: "Failed to save public ingress",
	});
}

export function enablePublicIngressFunnel(): Promise<PublicIngressSettings> {
	return request("/ingress/tailscale", {
		method: "POST",
		label: "Failed to enable Tailscale Funnel",
	});
}

export function configurePublicIngressCloudflare(input: {
	publicBaseUrl: string;
	tunnelId: string;
	token?: string;
}): Promise<PublicIngressSettings> {
	return request("/ingress/cloudflare", {
		method: "POST",
		body: input,
		label: "Failed to configure Cloudflare Tunnel",
	});
}

export function installPublicIngressCaddy(publicBaseUrl: string): Promise<PublicIngressSettings> {
	return request("/ingress/custom", {
		method: "POST",
		body: { publicBaseUrl },
		label: "Failed to configure Caddy",
	});
}

export function testPublicIngress(): Promise<PublicIngressSettings> {
	return request("/ingress/test", {
		method: "POST",
		label: "Failed to test public ingress",
	});
}
