export interface CaddyAccessInput {
	publicBaseUrl: string;
	webhookBaseUrl: string | null;
	tailnetIp: string | null;
	port: number;
	webhookPort: number;
}

function url(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

function domainHost(value: string, fallback: string): string {
	const parsed = url(value);
	if (!parsed || parsed.protocol !== "https:" || parsed.port) return fallback;
	const host = parsed.hostname;
	if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) return fallback;
	return host;
}

/** Hostnames shown in the DNS recipe. Before a valid HTTPS domain is typed,
 * the examples remain explicit placeholders rather than turning a tailnet IP
 * and port into an invalid Caddy site label. */
export function accessGuideHosts(input: CaddyAccessInput): {
	app: string;
	webhook: string | null;
} {
	return {
		app: domainHost(input.publicBaseUrl, "os.example.com"),
		webhook: input.webhookBaseUrl
			? domainHost(input.webhookBaseUrl, "hooks.example.com")
			: null,
	};
}

/** The safe default deployment: Caddy runs on the Open Session machine, the
 * app listener binds only to Tailscale, and both Open Session ports remain on
 * loopback. The private app certificate comes from DNS-01, while stock Caddy
 * can obtain the public webhook certificate itself. */
export function accessCaddyGuide(input: CaddyAccessInput): {
	hosts: ReturnType<typeof accessGuideHosts>;
	caddyfile: string;
} {
	const hosts = accessGuideHosts(input);
	const tailnetIp = input.tailnetIp || "100.x.x.x";
	const certificate = `/etc/caddy/certs/${hosts.app}`;
	const blocks = [
		`${hosts.app} {
    bind ${tailnetIp}
    tls ${certificate}.crt ${certificate}.key
    reverse_proxy 127.0.0.1:${input.port}
}`,
	];
	if (hosts.webhook) {
		blocks.push(`${hosts.webhook} {
    reverse_proxy 127.0.0.1:${input.webhookPort}
}`);
	}
	return { hosts, caddyfile: blocks.join("\n\n") };
}
