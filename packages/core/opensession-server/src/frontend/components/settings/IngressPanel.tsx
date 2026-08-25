import { useEffect, useState } from "react";
import {
	configurePublicIngressCloudflare,
	enablePublicIngressFunnel,
	fetchPublicIngress,
	installPublicIngressCaddy,
	testPublicIngress,
	type IngressExposure,
	type PublicIngressSettings,
} from "../../lib/api";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { OptionSelect } from "../../ui/select";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsField,
	SettingsForm,
	SettingsFormActions,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	StatusChip,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";

const EXPOSURE_OPTIONS: Array<{ value: IngressExposure; label: string }> = [
	{ value: "tailscale", label: "Tailscale Funnel" },
	{ value: "cloudflare", label: "Cloudflare Tunnel" },
	{ value: "custom", label: "Custom domain" },
];

function healthLabel(health: PublicIngressSettings["health"]): string {
	if (health === "ready") return "Ready";
	if (health === "unreachable") return "Unreachable";
	return "Not configured";
}

function healthDot(health: PublicIngressSettings["health"]): string {
	if (health === "ready") return "var(--green)";
	if (health === "unreachable") return "var(--red)";
	return "var(--text-faint)";
}

function draftHostname(value: string, fallback = "ingress.example.com"): string {
	try { return new URL(value).hostname || fallback; }
	catch { return fallback; }
}

function customDnsRecords(settings: PublicIngressSettings, value: string): string[] {
	const hostname = draftHostname(value);
	return settings.dns.suggested.map((record) => {
		const [type, _savedHost, ...target] = record.split(" ");
		return `${type} ${hostname} ${target.join(" ")}`;
	});
}

function CodeBlock({ children }: { children: string }) {
	return (
		<code className="block select-all overflow-x-auto whitespace-pre-wrap rounded-control bg-surface px-3 py-2 font-mono text-meta text-fg">
			{children}
		</code>
	);
}

export function IngressPanel() {
	const [settings, setSettings] = useState<PublicIngressSettings | null>(null);
	const [method, setMethod] = useState<IngressExposure>("tailscale");
	const [url, setUrl] = useState("");
	const [tunnelId, setTunnelId] = useState("");
	const [tunnelToken, setTunnelToken] = useState("");
	const [busy, setBusy] = useState<"apply" | "test" | null>(null);
	const [error, setError] = useState<string | null>(null);

	function apply(next: PublicIngressSettings) {
		setSettings(next);
		setMethod(next.exposure || (next.tailscale.installed ? "tailscale" : "custom"));
		setUrl(next.publicBaseUrl || next.tailscale.suggestedUrl);
		setTunnelId(next.cloudflare.tunnelId);
		setTunnelToken("");
	}

	useEffect(() => {
		void fetchPublicIngress().then(apply).catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : "Couldn’t load public ingress");
		});
	}, []);

	async function run(kind: "apply" | "test", work: () => Promise<PublicIngressSettings>, message: string) {
		if (busy) return;
		setBusy(kind);
		setError(null);
		await work()
			.then((next) => {
				apply(next);
				toast(message, { variant: "success" });
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "Public ingress could not be updated");
			})
			.finally(() => setBusy(null));
	}

	async function applyMethod() {
		if (method === "tailscale") {
			await run("apply", enablePublicIngressFunnel, "Tailscale Funnel enabled");
			return;
		}
		if (method === "custom") {
			await run("apply", () => installPublicIngressCaddy(url), "Custom ingress enabled");
			return;
		}
		await run(
			"apply",
			() => configurePublicIngressCloudflare({
				publicBaseUrl: url,
				tunnelId,
				...(tunnelToken ? { token: tunnelToken } : {}),
			}),
			"Cloudflare Tunnel enabled",
		);
	}

	return (
		<SettingsPanel>
			<SettingsHeader
				title="Public ingress"
				description="Expose signed webhooks, remote Sandbox callbacks, and workload identity on a separate endpoint."
			/>

			<SettingsGroupLabel
				actions={settings ? <StatusChip label={healthLabel(settings.health)} dot={healthDot(settings.health)} /> : undefined}
			>
				Status
			</SettingsGroupLabel>
			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			{!settings ? (
				<SettingCardSkeleton rows={3} label="Loading public ingress" />
			) : (
				<>
					<SettingCard>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Public URL</SettingRowTitle>
								<SettingRowDescription className="break-all font-mono">
									{settings.publicBaseUrl || "No public origin configured"}
								</SettingRowDescription>
							</SettingRowText>
						</SettingRow>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>App endpoint</SettingRowTitle>
								<SettingRowDescription>Separate from this public listener.</SettingRowDescription>
							</SettingRowText>
							<StatusChip label="Separate" dot="var(--green)" />
						</SettingRow>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Public capabilities</SettingRowTitle>
								<SettingRowDescription>Webhooks · Sandbox callbacks · Workload identity</SettingRowDescription>
							</SettingRowText>
						</SettingRow>
					</SettingCard>

					<SettingsGroupLabel>Exposure</SettingsGroupLabel>
					<SettingsForm>
						<SettingsField>
							Method
							<OptionSelect
								label="Ingress exposure method"
								value={method}
								options={EXPOSURE_OPTIONS}
								disabled={!!busy || !settings.canManage}
								className="w-full"
								onChange={(next) => {
									setMethod(next);
									if (next === "tailscale" && settings.tailscale.suggestedUrl) setUrl(settings.tailscale.suggestedUrl);
								}}
							/>
						</SettingsField>

						{method === "tailscale" && (
							<>
								<SettingsField>
									Tailscale URL
									<Input value={settings.tailscale.suggestedUrl} readOnly className="font-mono" />
								</SettingsField>
								<p className="m-0 text-supporting text-dim">
									Funnel provides HTTPS without DNS records or inbound firewall ports. It uses this machine’s Tailscale hostname.
								</p>
								{!settings.tailscale.installed && <InlineAlert>Tailscale is not installed on this server.</InlineAlert>}
							</>
						)}

						{method === "cloudflare" && (
							<>
								<SettingsField>
									Public URL
									<Input type="url" value={url} placeholder="https://ingress.example.com" disabled={!!busy} onChange={(event) => setUrl(event.target.value)} />
								</SettingsField>
								<SettingsField>
									Tunnel ID
									<Input value={tunnelId} placeholder="00000000-0000-0000-0000-000000000000" disabled={!!busy} className="font-mono" onChange={(event) => setTunnelId(event.target.value)} />
								</SettingsField>
								<SettingsField>
									Tunnel token
									<Input
										type="password"
										value={tunnelToken}
										disabled={!!busy}
										autoComplete="off"
										placeholder={settings.cloudflare.tokenConfigured ? "Leave blank to keep the saved token" : "Paste the connector token"}
										onChange={(event) => setTunnelToken(event.target.value)}
									/>
								</SettingsField>
								<div className="grid gap-2">
									<div className="text-label font-medium text-dim">DNS record</div>
									<CodeBlock>{`CNAME ${draftHostname(url)} ${tunnelId || "<tunnel-id>"}.cfargotunnel.com`}</CodeBlock>
									<div className="text-label font-medium text-dim">Tunnel service</div>
									<CodeBlock>{settings.cloudflare.connectorTarget}</CodeBlock>
								</div>
								<p className="m-0 text-supporting text-dim">
									Only this ingress service belongs in the tunnel. Do not add the private app port.
								</p>
								{settings.cloudflare.connectorRunning && <StatusChip label="Connector running" dot="var(--green)" />}
								{!settings.cloudflare.installed && <InlineAlert>cloudflared is not installed on this server.</InlineAlert>}
							</>
						)}

						{method === "custom" && (
							<>
								<SettingsField>
									Public URL
									<Input type="url" value={url} placeholder="https://ingress.example.com" disabled={!!busy} onChange={(event) => setUrl(event.target.value)} />
								</SettingsField>
								<div className="grid gap-2">
									<div className="text-label font-medium text-dim">DNS records</div>
									{customDnsRecords(settings, url).length ? customDnsRecords(settings, url).map((record) => <CodeBlock key={record}>{record}</CodeBlock>) : <p className="m-0 text-supporting text-dim">Point the hostname’s A and AAAA records at this server’s public addresses.</p>}
								</div>
								{!settings.custom.caddyInstalled && <InlineAlert>Caddy is not installed on this server.</InlineAlert>}
								<details className="rounded-lg bg-surface p-3 text-meta text-dim">
									<summary className="cursor-pointer font-medium text-fg">Generated Caddy configuration</summary>
									<pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-meta">{settings.custom.generatedConfig}</pre>
								</details>
							</>
						)}

						<SettingsFormActions>
							<Button variant="soft" disabled={!!busy || !settings.canManage || !settings.publicBaseUrl} onClick={() => void run("test", testPublicIngress, "Public ingress is reachable")}>
								{busy === "test" ? "Testing…" : "Test"}
							</Button>
							<Button variant="primary" disabled={!!busy || !settings.canManage || (method !== "tailscale" && !url.trim()) || (method === "cloudflare" && (!tunnelId.trim() || (!tunnelToken.trim() && !settings.cloudflare.tokenConfigured)))} onClick={() => void applyMethod()}>
								{busy === "apply" ? "Saving…" : method === "tailscale" ? "Enable Funnel" : method === "custom" ? "Set up domain" : "Enable tunnel"}
							</Button>
						</SettingsFormActions>
					</SettingsForm>
					<SettingsHint>
						Public ingress never serves sessions, APIs, or the app UI. Unknown methods and paths return 404.
					</SettingsHint>
				</>
			)}
		</SettingsPanel>
	);
}
