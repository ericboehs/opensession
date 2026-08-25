import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	configurePublicIngressCloudflare,
	enablePublicIngressFunnel,
	fetchPublicIngress,
	installPublicIngressCaddy,
	testPublicIngress,
	type IngressExposure,
	type PublicIngressSettings,
} from "../../lib/api";
import {
	configuredIngressDrafts,
	customCaddyConfig,
	customDnsRecords,
	INGRESS_METHODS,
	ingressHealthDot,
	ingressHealthLabel,
	ingressHostname,
} from "../../lib/ingress-ui";
import { Button } from "../../ui/button";
import { CopyCheck, useCopy } from "../../ui/copy";
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
import { IconCopy } from "../icons";

const EMPTY_DRAFTS: Record<IngressExposure, string> = {
	tailscale: "",
	cloudflare: "",
	custom: "",
};

function CodeBlock({ children }: { children: string }) {
	const { copied, copy } = useCopy();
	return (
		<div className="flex min-w-0 items-center gap-1 rounded-control bg-surface py-1 pr-1 pl-3">
			<code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-pre-wrap font-mono text-meta text-fg">
				{children}
			</code>
			<Button
				variant="ghost"
				size="sm"
				aria-label={copied ? "Copied" : "Copy command"}
				icon={<CopyCheck copied={copied} size={15} idle={<IconCopy size={15} />} />}
				className="shrink-0 phone:size-10 phone:justify-center phone:p-0"
				onClick={() => copy(children, { toast: "Copied" })}
			/>
		</div>
	);
}

function SetupSteps({ children }: { children: React.ReactNode }) {
	return <ol className="m-0 grid list-none gap-3 p-0 text-supporting text-dim">{children}</ol>;
}

function SetupStep({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
	return (
		<li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
			<span className="flex size-6 items-center justify-center rounded-full bg-surface text-meta font-semibold text-dim">
				{number}
			</span>
			<div className="min-w-0 pt-0.5">
				<div className="font-medium text-fg">{title}</div>
				<div className="mt-1 grid gap-2 leading-relaxed">{children}</div>
			</div>
		</li>
	);
}

export function IngressPanel({
	onboarding = false,
	onChanged,
	onStatusChange,
}: {
	onboarding?: boolean;
	onChanged?: () => void | Promise<void>;
	onStatusChange?: (settings: PublicIngressSettings) => void;
} = {}) {
	const [settings, setSettings] = useState<PublicIngressSettings | null>(null);
	const [method, setMethod] = useState<IngressExposure>("tailscale");
	const [drafts, setDrafts] = useState<Record<IngressExposure, string>>(EMPTY_DRAFTS);
	const [tunnelId, setTunnelId] = useState("");
	const [tunnelToken, setTunnelToken] = useState("");
	const [busy, setBusy] = useState<"apply" | "test" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const loaded = useRef(false);
	const url = drafts[method];

	function apply(next: PublicIngressSettings, selectConfigured = true) {
		setSettings(next);
		onStatusChange?.(next);
		if (!loaded.current) {
			setDrafts(configuredIngressDrafts(next));
			loaded.current = true;
		} else if (next.exposure) {
			const saved = configuredIngressDrafts(next)[next.exposure];
			setDrafts((current) => ({ ...current, [next.exposure!]: saved }));
		}
		if (selectConfigured) {
			setMethod(next.exposure || (next.tailscale.installed ? "tailscale" : "custom"));
		}
		setTunnelId(next.cloudflare.tunnelId);
		setTunnelToken("");
	}

	const applyFromEffect = useEffectEvent(apply);

	useEffect(() => {
		void fetchPublicIngress().then((next) => applyFromEffect(next)).catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : "Couldn’t load public ingress");
		});
	}, []);

	// A custom-domain setup is complete before public DNS necessarily reaches
	// this server. Keep the explicit waiting state current without making the
	// operator repeatedly click a probe while their provider propagates it.
	useEffect(() => {
		if (settings?.health !== "waiting_dns") return;
		const timer = window.setInterval(() => {
			void fetchPublicIngress().then((next) => applyFromEffect(next, false)).catch(() => {});
		}, 5_000);
		return () => window.clearInterval(timer);
	}, [settings?.health]);

	async function run(
		kind: "apply" | "test",
		work: () => Promise<PublicIngressSettings>,
		message: string | ((next: PublicIngressSettings) => string),
	) {
		if (busy) return;
		setBusy(kind);
		setError(null);
		await work()
			.then((next) => {
				apply(next);
				toast(typeof message === "function" ? message(next) : message, { variant: "success" });
				void onChanged?.();
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "Public ingress could not be updated");
			})
			.finally(() => setBusy(null));
	}

	async function applyMethod() {
		if (method === "tailscale") {
			await run("apply", enablePublicIngressFunnel, "Tailscale Funnel started");
			return;
		}
		if (method === "custom") {
			await run(
				"apply",
				() => installPublicIngressCaddy(url),
				(next) => next.health === "ready" ? "Public ingress is ready" : "Caddy configured. Waiting for DNS",
			);
			return;
		}
		await run(
			"apply",
			() => configurePublicIngressCloudflare({
				publicBaseUrl: url,
				tunnelId,
				...(tunnelToken ? { token: tunnelToken } : {}),
			}),
			"Cloudflare Tunnel started",
		);
	}

	const methodInfo = INGRESS_METHODS.find((option) => option.value === method)!;
	const records = settings ? customDnsRecords(settings, drafts.custom) : [];
	const missingTool = settings && (
		(method === "tailscale" && !settings.tailscale.installed) ||
		(method === "cloudflare" && !settings.cloudflare.installed) ||
		(method === "custom" && !settings.custom.caddyInstalled)
	);
	const invalidInput =
		method !== "tailscale" && !url.trim() ||
		method === "cloudflare" && (!tunnelId.trim() || (!tunnelToken.trim() && !settings?.cloudflare.tokenConfigured));

	return (
		<SettingsPanel className={onboarding ? "mx-auto" : undefined}>
			{!onboarding && (
				<SettingsHeader
					title="Public ingress"
					description="Create a separate public HTTPS endpoint for signed webhooks, remote Sandbox callbacks, and workload identity. The app itself stays private."
				/>
			)}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			{!settings ? (
				<SettingCardSkeleton rows={3} label="Loading public ingress" />
			) : (
				<>
					{!onboarding && (
						<>
							<SettingsGroupLabel
								actions={<StatusChip label={busy === "apply" ? "Setting up" : ingressHealthLabel(settings.health)} dot={busy === "apply" ? "var(--yellow)" : ingressHealthDot(settings.health)} />}
							>
								Status
							</SettingsGroupLabel>
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
										<SettingRowTitle>What it exposes</SettingRowTitle>
										<SettingRowDescription>Only signed webhooks, Sandbox callbacks, and workload identity. Sessions, APIs, and the app UI stay private.</SettingRowDescription>
									</SettingRowText>
								</SettingRow>
							</SettingCard>
						</>
					)}

					<SettingsGroupLabel
						className={onboarding ? "mt-0" : undefined}
						actions={onboarding ? <StatusChip label={busy === "apply" ? "Setting up" : ingressHealthLabel(settings.health)} dot={busy === "apply" ? "var(--yellow)" : ingressHealthDot(settings.health)} /> : undefined}
					>
						Exposure
					</SettingsGroupLabel>
					<SettingsForm>
						<p className="m-0 text-supporting leading-relaxed text-dim">
							GitHub and remote Sandboxes need one narrow endpoint they can reach from the public internet. Choose how traffic reaches the isolated listener on this server.
						</p>
						<SettingsField>
							Method
							<OptionSelect
								label="Ingress exposure method"
								value={method}
								options={INGRESS_METHODS}
								disabled={!!busy || !settings.canManage}
								className="w-full"
								onChange={(next) => setMethod(next as IngressExposure)}
							/>
						</SettingsField>
						<p className="-mt-3 m-0 text-supporting text-dim">{methodInfo.description}</p>

						{method === "tailscale" && (
							<SetupSteps>
								<SetupStep number={1} title="Connect this server to Tailscale">
									<p className="m-0">The server must have a Tailscale DNS name. Funnel may also need to be allowed in your tailnet policy.</p>
									{!settings.tailscale.installed && <CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --no-onboard"}</CodeBlock>}
								</SetupStep>
								<SetupStep number={2} title="Start Funnel">
									<p className="m-0">Open Session sends public HTTPS traffic only to its isolated listener. No DNS records or inbound ports are needed.</p>
									<SettingsField className="mb-0">
										Public URL
										<Input value={settings.tailscale.suggestedUrl} readOnly className="font-mono" placeholder="Connect Tailscale to discover the URL" />
									</SettingsField>
								</SetupStep>
							</SetupSteps>
						)}

						{method === "cloudflare" && (
							<>
								{!settings.cloudflare.installed && (
									<InlineAlert>
										Install cloudflared first, then reload this page.
										<div className="mt-2"><CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --cloudflare --no-onboard"}</CodeBlock></div>
									</InlineAlert>
								)}
								<p className="m-0 text-supporting text-dim">Run these commands in a terminal on the Open Session server.</p>
								<SetupSteps>
									<SetupStep number={1} title="Sign in to Cloudflare">
										<CodeBlock>cloudflared tunnel login</CodeBlock>
										<p className="m-0">Choose the Cloudflare account and zone that will own your ingress domain.</p>
									</SetupStep>
									<SetupStep number={2} title="Create a named tunnel">
										<CodeBlock>cloudflared tunnel create opensession</CodeBlock>
										<p className="m-0">Copy the UUID printed by this command into Tunnel ID below.</p>
									</SetupStep>
									<SetupStep number={3} title="Add the DNS route">
										<SettingsField className="mb-0">
											Public URL
											<Input key={method} type="url" value={url} placeholder="https://ingress.example.com" disabled={!!busy} onChange={(event) => setDrafts((current) => ({ ...current, cloudflare: event.target.value }))} />
										</SettingsField>
										<CodeBlock>{`cloudflared tunnel route dns opensession ${ingressHostname(url)}`}</CodeBlock>
									</SetupStep>
									<SetupStep number={4} title="Generate the connector token">
										<CodeBlock>cloudflared tunnel token opensession</CodeBlock>
										<p className="m-0">Paste the printed token below. Open Session stores it on this server and starts the connector for you.</p>
									</SetupStep>
								</SetupSteps>
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
									<div className="text-label font-medium text-dim">Tunnel destination</div>
									<CodeBlock>{settings.cloudflare.connectorTarget}</CodeBlock>
									<p className="m-0 text-supporting text-dim">Use this isolated listener only. Never route the private app port through the tunnel.</p>
								</div>
								{settings.cloudflare.connectorRunning && <StatusChip label="Connector running" dot="var(--green)" />}
							</>
						)}

						{method === "custom" && (
							<>
								<SetupSteps>
									<SetupStep number={1} title="Choose a separate public domain">
										<SettingsField className="mb-0">
											Domain
											<Input key={method} value={url} placeholder="ingress.example.com" disabled={!!busy} autoCapitalize="none" spellCheck={false} onChange={(event) => setDrafts((current) => ({ ...current, custom: event.target.value }))} />
										</SettingsField>
										<p className="m-0">Do not use the private app hostname. HTTPS is added automatically.</p>
									</SetupStep>
									<SetupStep number={2} title="Open ports 80 and 443">
										<p className="m-0">Allow inbound TCP traffic from the public internet to ports 80 and 443 in the server firewall and your cloud security group. Caddy uses port 80 for certificate validation and serves HTTPS on port 443.</p>
									</SetupStep>
									<SetupStep number={3} title="Add DNS records at your provider">
										<p className="m-0">Point the domain to this server’s public IP address, not its private or Tailscale address.</p>
										{records.length ? records.map((record) => <CodeBlock key={record}>{record}</CodeBlock>) : (
											<InlineAlert>Open Session could not detect this server’s public IP. Set OPENSESSION_PUBLIC_IPV4 or OPENSESSION_PUBLIC_IPV6 for the service, restart it, and reload this page.</InlineAlert>
										)}
									</SetupStep>
									<SetupStep number={4} title="Configure Caddy">
										<p className="m-0">Open Session adds this dedicated site to /etc/caddy/Caddyfile and reloads Caddy. If DNS is still propagating, the status stays at Waiting for DNS and checks again automatically.</p>
										{!settings.custom.caddyInstalled && <CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --caddy --no-onboard"}</CodeBlock>}
									</SetupStep>
								</SetupSteps>
								<details className="rounded-lg bg-surface p-3 text-meta text-dim">
									<summary className="cursor-pointer font-medium text-fg">Generated Caddy configuration</summary>
									<pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-meta">{customCaddyConfig(url)}</pre>
								</details>
								{settings.health === "waiting_dns" && settings.exposure === "custom" && (
									<InlineAlert>DNS does not point to this server yet. Keep this page open or click Check again after updating the records.</InlineAlert>
								)}
							</>
						)}

						{settings.health === "unreachable" && settings.exposure === method && (
							<InlineAlert>The public URL is configured but its health check is not reachable. Verify DNS, the connector, and any firewall rules, then check again.</InlineAlert>
						)}

						<SettingsFormActions className="phone:flex-col-reverse">
							<Button variant="soft" disabled={!!busy || !settings.canManage || !settings.publicBaseUrl} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={() => void run("test", testPublicIngress, (next) => next.health === "ready" ? "Public ingress is reachable" : "Public ingress is not ready yet") }>
								{busy === "test" ? "Checking…" : settings.health === "waiting_dns" ? "Check again" : "Test connection"}
							</Button>
							<Button variant="primary" disabled={!!busy || !settings.canManage || !!missingTool || invalidInput} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={() => void applyMethod()}>
								{busy === "apply" ? "Setting up…" : method === "tailscale" ? "Start Funnel" : method === "custom" ? settings.exposure === "custom" ? "Update Caddy" : "Configure Caddy" : "Start tunnel"}
							</Button>
						</SettingsFormActions>
					</SettingsForm>
					<SettingsHint>
						Unknown methods and paths return 404. This endpoint never serves sessions, APIs, or the app UI.
					</SettingsHint>
				</>
			)}
		</SettingsPanel>
	);
}
