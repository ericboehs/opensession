import { describe, expect, test } from "bun:test";
import {
	configuredIngressDrafts,
	customCaddyConfig,
	customDnsRecords,
	ingressHostname,
} from "./ingress-ui";
import type { PublicIngressSettings } from "./api/ingress";

const settings = {
	publicBaseUrl: "https://old.example.test",
	exposure: "custom",
	server: { ipv4: ["203.0.113.10"], ipv6: ["2001:db8::10"] },
	tailscale: { suggestedUrl: "https://server.example.ts.net" },
} as PublicIngressSettings;

describe("public ingress form", () => {
	test("keeps one draft per exposure method", () => {
		expect(configuredIngressDrafts(settings)).toEqual({
			tailscale: "https://server.example.ts.net",
			cloudflare: "",
			custom: "old.example.test",
		});
	});

	test("accepts a bare custom domain for DNS and Caddy instructions", () => {
		expect(ingressHostname("new.example.test")).toBe("new.example.test");
		expect(customDnsRecords(settings, "new.example.test")).toEqual([
			"A new.example.test 203.0.113.10",
			"AAAA new.example.test 2001:db8::10",
		]);
		expect(customCaddyConfig("new.example.test")).toContain("new.example.test {");
	});
});
