import { describe, expect, test } from "bun:test";
import { accessCaddyGuide, accessGuideHosts } from "./setup-access";

const input = {
	publicBaseUrl: "https://os.example.com",
	webhookBaseUrl: "https://hooks.example.com",
	tailnetIp: "100.72.1.4",
	port: 3850,
	webhookPort: 3848,
};

describe("setup access Caddy guide", () => {
	test("keeps the app private and routes webhooks to the isolated listener", () => {
		const { caddyfile } = accessCaddyGuide(input);
		expect(caddyfile).toContain("os.example.com {");
		expect(caddyfile).toContain("bind 100.72.1.4");
		expect(caddyfile).toContain("reverse_proxy 127.0.0.1:3850");
		expect(caddyfile).toContain("hooks.example.com {");
		expect(caddyfile).toContain("reverse_proxy 127.0.0.1:3848");
		expect(caddyfile.match(/bind /g)).toHaveLength(1);
	});

	test("omits the public host until a separate webhook address is set", () => {
		const { caddyfile } = accessCaddyGuide({
			...input,
			webhookBaseUrl: null,
		});
		expect(caddyfile).not.toContain("hooks.example.com");
		expect(caddyfile).not.toContain("3848");
	});

	test("uses clear placeholders for direct IP addresses", () => {
		expect(
			accessGuideHosts({
				...input,
				publicBaseUrl: "http://100.72.1.4:3850",
			}),
		).toEqual({ app: "os.example.com", webhook: "hooks.example.com" });
	});
});
