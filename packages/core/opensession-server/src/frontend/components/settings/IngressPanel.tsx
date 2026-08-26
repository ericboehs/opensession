import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
	configurePublicIngressCloudflare,
	enablePublicIngressFunnel,
	fetchPublicIngress,
	installPublicIngressCaddy,
	savePrivateAppDomain,
	setupPrivateAppDomain,
	testPrivateAppDomain,
	testPublicIngress,
	type IngressExposure,
	type PublicIngressSettings,
} from "../../lib/api";
import { ApiError } from "../../lib/api/request";
import {
	configuredAppDomain,
	configuredIngressDrafts,
	customCaddyConfig,
	customDnsRecords,
	INGRESS_METHODS,
	ingressHealthDot,
	ingressHealthLabel,
	ingressHostname,
	privateAppCaddyConfig,
	privateAppDnsRecord,
	publicUrlForMethod,
} from "../../lib/ingress-ui";
import { useSetupStatus, type SetupController } from "../../hooks/useSetupStatus";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { CopyCheck, useCopy } from "../../ui/copy";
import { Input } from "../../ui/input";
import { Radio, RadioGroup } from "../../ui/radio";
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
import { InlineAlert, LoadingState } from "../../ui/state";
import { toast } from "../../ui/toast";
import { markTileClass, markTileGradient, markTileInk, markTileShadow, type MarkTone } from "../../lib/mark-tile";
import { IconCopy, IconGlobe, IconServer, IconShieldCheck } from "../icons";
import { SetupRestart } from "../SetupRestart";

const EMPTY_DRAFTS: Record<IngressExposure, string> = {
	tailscale: "",
	cloudflare: "",
	custom: "",
};

/** Each method's plate, so a choice reads the same in the list and in the
 *  panel it opens — the leading mark is what ties the two halves together in
 *  the server setup this mirrors. */
const METHOD_MARKS: Record<IngressExposure, { tone: MarkTone; icon: typeof IconGlobe }> = {
	tailscale: { tone: "indigo", icon: IconShieldCheck },
	cloudflare: { tone: "sky", icon: IconGlobe },
	custom: { tone: "orange", icon: IconServer },
};

function MethodMark({ method, size = 44 }: { method: IngressExposure; size?: number }) {
	const { tone, icon: Icon } = METHOD_MARKS[method];
	return (
		<span
			className={`${markTileClass(size)} plate-sheen`}
			style={{
				width: size,
				height: size,
				backgroundImage: markTileGradient(tone),
				color: "#fff",
				boxShadow: markTileShadow(markTileInk(tone)),
			}}
		>
			<Icon size={Math.round(size * 0.5)} />
		</span>
	);
}

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

/** A generated config file shown like a chat code fence, with its copy
 *  control fixed in the top-right corner. */
function ConfigCodeBlock({ code }: { code: string }) {
	const { copied, copy } = useCopy();
	return (
		<div className="relative overflow-hidden rounded-xl border border-code-well-line bg-code-well py-2.5 pr-14 pl-3.5 text-code-well-ink">
			<Button
				variant="ghost"
				size="sm"
				aria-label={copied ? "Copied" : "Copy configuration"}
				icon={<CopyCheck copied={copied} size={15} idle={<IconCopy size={15} />} />}
				className="absolute top-1 right-1 shrink-0 phone:size-10 phone:justify-center phone:p-0"
				onClick={() => copy(code, { toast: "Copied" })}
			/>
			<pre className="m-0 overflow-x-auto font-mono text-meta whitespace-pre-wrap [overflow-wrap:anywhere]">{code}</pre>
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

function IngressWaitingState({
	method,
	health,
}: {
	method: IngressExposure;
	health: PublicIngressSettings["health"];
}) {
	if (health !== "starting" && health !== "waiting_dns") return null;
	const message = method === "tailscale"
		? "Waiting for Tailscale’s public DNS. This can take up to 10 minutes."
		: method === "cloudflare"
			? "Waiting for Cloudflare to connect the public route."
			: health === "waiting_dns"
				? "Waiting for DNS to point to this server."
				: "Waiting for Caddy to finish HTTPS setup.";
	return <LoadingState placement="card">{message} This page checks automatically.</LoadingState>;
}

function DomainSetupSteps({
	value,
	onValueChange,
	appStatus,
	callbackStatus,
}: {
	value: "domain" | "callbacks";
	onValueChange: (value: "domain" | "callbacks") => void;
	appStatus: PublicIngressSettings["app"]["domain"]["health"];
	callbackStatus: PublicIngressSettings["health"];
}) {
	const steps = [
		{
			value: "domain" as const,
			number: 1,
			title: "Friendly domain",
			description: "Give your team a memorable address while keeping the app private.",
			status: appStatus,
		},
		{
			value: "callbacks" as const,
			number: 2,
			title: "Public callbacks",
			description: "Required for GitHub webhooks and remote Sandbox callbacks. The public endpoint never exposes the app.",
			status: callbackStatus,
		},
	];
	return (
		<SettingCard className="mb-5">
			<ol className="m-0 grid list-none grid-cols-2 p-0 phone:grid-cols-1">
				{steps.map((step, index) => {
					const active = value === step.value;
					return (
						<li key={step.value} className={cn(index > 0 && "border-l border-line phone:border-t phone:border-l-0")}>
							<button
								type="button"
								aria-current={active ? "step" : undefined}
								className={cn(
									"flex min-h-28 w-full items-start gap-3.5 px-5 py-4 text-left transition-[background-color] hover:bg-hover phone:min-h-0 phone:py-4",
									active && "bg-pressed",
								)}
								onClick={() => onValueChange(step.value)}
							>
								<span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-label font-semibold text-dim", active && "bg-fg text-panel")}>
									{step.number}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
										<span className="text-item-title font-semibold text-fg">{step.title}</span>
										<StatusChip label={ingressHealthLabel(step.status)} dot={ingressHealthDot(step.status)} />
									</span>
									<span className="mt-1.5 block text-supporting leading-relaxed text-dim">{step.description}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ol>
		</SettingCard>
	);
}

function PrivateAppSetup({
	settings,
	domain,
	onboarding,
	email,
	apiToken,
	provider,
	teamId,
	busy,
	action,
	onDomainChange,
	onEmailChange,
	onTokenChange,
	onProviderChange,
	onTeamIdChange,
	onSetup,
	onVerify,
	onSaveManual,
}: {
	settings: PublicIngressSettings;
	domain: string;
	onboarding: boolean;
	email: string;
	apiToken: string;
	provider: "cloudflare" | "vercel";
	teamId: string;
	busy: boolean;
	action: "setup" | "verify" | "save" | null;
	onDomainChange: (value: string) => void;
	onEmailChange: (value: string) => void;
	onTokenChange: (value: string) => void;
	onProviderChange: (value: "cloudflare" | "vercel") => void;
	onTeamIdChange: (value: string) => void;
	onSetup: () => void;
	onVerify: () => void;
	onSaveManual: () => void;
}) {
	const savedDomain = configuredAppDomain(settings);
	const dnsRecord = privateAppDnsRecord(settings, domain);
	const dirty = domain.trim() !== savedDomain;
	const managedCredential = settings.app.domain.credentialConfigured && domain.trim() === savedDomain && settings.app.domain.dnsProvider === provider;
	const managedInputMissing = !domain.trim() || (!managedCredential && (!email.trim() || !apiToken.trim()));
	const status = settings.app.domain.health;
	return (
		<>
			{!onboarding && (
				<SettingCard>
					<SettingRow>
						<SettingRowText>
							<SettingRowTitle>Current address</SettingRowTitle>
							<div className="selectable mt-1 break-all font-mono text-supporting text-dim">{settings.app.publicBaseUrl}</div>
						</SettingRowText>
					</SettingRow>
					{settings.app.domain.certificateExpiresAt && (
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Certificate</SettingRowTitle>
								<SettingRowDescription>
									Valid until {new Date(settings.app.domain.certificateExpiresAt).toLocaleDateString()}
									{settings.app.domain.credentialConfigured ? ". Renewal is automatic." : ". Managed outside Open Session."}
								</SettingRowDescription>
							</SettingRowText>
						</SettingRow>
					)}
				</SettingCard>
			)}
			<SettingsForm className={onboarding ? "mt-0" : "mt-3"}>
				{status === "ready" && !settings.app.domain.credentialConfigured && (
					<SettingsHint className="m-0">This address is already working. Its certificate is managed outside Open Session.</SettingsHint>
				)}
				<SetupSteps>
							<SetupStep number={1} title="Choose the app domain">
								<SettingsField className="mb-0">
									Domain
									<Input value={domain} placeholder="os.example.com" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onDomainChange(event.target.value)} />
								</SettingsField>
								<p className="m-0">Keep it different from the public callback domain.</p>
							</SetupStep>
							<SetupStep number={2} title="Authorize the DNS provider">
								<SettingCard>
									<RadioGroup aria-label="Private domain DNS provider" value={provider} disabled={busy} onValueChange={(value) => onProviderChange(value as "cloudflare" | "vercel")}>
										<label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-3">
											<Radio value="cloudflare" />
											<span className="font-medium text-fg">Cloudflare DNS</span>
										</label>
										<label className="flex min-h-11 cursor-pointer items-center gap-3 border-t border-line px-4 py-3">
											<Radio value="vercel" />
											<span className="font-medium text-fg">Vercel DNS</span>
										</label>
									</RadioGroup>
								</SettingCard>
								<p className="m-0">
									{provider === "cloudflare"
										? <>Create a token with <strong className="font-medium text-fg">Zone:DNS Edit</strong> and <strong className="font-medium text-fg">Zone:Zone Read</strong> for this zone.</>
										: <>Create a Vercel token with access to the team that owns this domain.</>}
									{" "}Open Session protects it with server file permissions and never returns it to the browser.
								</p>
								<a className="w-fit text-link hover:underline" href={provider === "cloudflare" ? "https://dash.cloudflare.com/profile/api-tokens" : "https://vercel.com/account/settings/tokens"} target="_blank" rel="noreferrer">Create {provider === "cloudflare" ? "Cloudflare" : "Vercel"} token</a>
								<SettingsField className="mb-0">
									Certificate email
									<Input type="email" value={email} placeholder={managedCredential && settings.app.domain.certificateEmailConfigured ? "Leave blank to keep the saved email" : "you@example.com"} disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onEmailChange(event.target.value)} />
								</SettingsField>
								<SettingsField className="mb-0">
									{provider === "cloudflare" ? "Cloudflare" : "Vercel"} API token
									<Input type="password" value={apiToken} placeholder={managedCredential ? "Leave blank to keep the saved token" : "Paste the scoped token"} disabled={busy} autoComplete="off" onChange={(event) => onTokenChange(event.target.value)} />
								</SettingsField>
								{provider === "vercel" && (
									<SettingsField className="mb-0">
										Team ID <span className="font-normal text-faint">Optional</span>
										<Input value={teamId} placeholder="team_…" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onTeamIdChange(event.target.value)} />
									</SettingsField>
								)}
							</SetupStep>
							<SetupStep number={3} title="Set up and verify">
								<p className="m-0">Open Session creates the DNS-only A record, requests a Let’s Encrypt certificate with DNS-01, configures Caddy, and checks the private address. It checks renewal daily.</p>
								{(!settings.custom.caddyInstalled || !settings.app.domain.legoInstalled) && (
									<>
										<InlineAlert>Install Caddy and the certificate helper first, then reload this page.</InlineAlert>
										<CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --caddy --no-onboard"}</CodeBlock>
									</>
								)}
							</SetupStep>
						</SetupSteps>
						{status === "waiting_dns" && <InlineAlert>DNS has not reached this server yet. Wait a moment, then verify again.</InlineAlert>}
						{status === "unreachable" && ingressHostname(domain) === ingressHostname(savedDomain) && (
							<InlineAlert>DNS points to this server, but the HTTPS app is not reachable. Verify Caddy and the certificate, then try again.</InlineAlert>
						)}
						<SettingsFormActions className="phone:flex-col-reverse">
							<Button variant="soft" disabled={busy || !savedDomain || !settings.canManage} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={onVerify}>
								{action === "verify" ? "Checking…" : "Verify address"}
							</Button>
							<Button variant="primary" disabled={busy || managedInputMissing || !dnsRecord || !settings.custom.caddyInstalled || !settings.app.domain.legoInstalled || !settings.canManage} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={onSetup}>
								{action === "setup" ? "Setting up…" : managedCredential ? "Update setup" : "Set up private domain"}
							</Button>
				</SettingsFormActions>
				<details className="rounded-lg bg-surface p-3 text-meta text-dim">
					<summary className="cursor-pointer font-medium text-fg">Use an externally managed certificate</summary>
					<div className="mt-3 grid gap-4">
						<SetupSteps>
							<SetupStep number={1} title="Choose the app domain">
								<SettingsField className="mb-0">
									Domain
									<Input value={domain} placeholder="os.example.com" disabled={busy} autoCapitalize="none" spellCheck={false} onChange={(event) => onDomainChange(event.target.value)} />
								</SettingsField>
							</SetupStep>
							<SetupStep number={2} title="Point DNS to Tailscale">
								<p className="m-0">Add this DNS-only record at your provider. Only devices on your tailnet can connect.</p>
								{dnsRecord ? <CodeBlock>{dnsRecord}</CodeBlock> : <InlineAlert>Connect this server to Tailscale first, then reload this page.</InlineAlert>}
							</SetupStep>
							<SetupStep number={3} title="Install existing TLS files">
								<p className="m-0">Only use this path when your infrastructure already issues and renews the certificate.</p>
								<CodeBlock>{`/etc/opensession/tls/${ingressHostname(domain, "os.example.com")}.crt`}</CodeBlock>
								<CodeBlock>{`/etc/opensession/tls/${ingressHostname(domain, "os.example.com")}.key`}</CodeBlock>
							</SetupStep>
							<SetupStep number={4} title="Configure Caddy">
								<p className="m-0">Bind Caddy only to the Tailscale address and forward the app to loopback.</p>
							</SetupStep>
						</SetupSteps>
						<details className="text-meta text-dim">
							<summary className="cursor-pointer font-medium text-fg">Generated Caddy configuration</summary>
							<div className="mt-2"><ConfigCodeBlock code={privateAppCaddyConfig(settings, domain)} /></div>
						</details>
						<div className="grid gap-2">
							<div className="text-label font-medium text-dim">Apply Caddy</div>
							<CodeBlock>sudo caddy validate --config /etc/caddy/Caddyfile</CodeBlock>
							<CodeBlock>sudo systemctl reload caddy</CodeBlock>
						</div>
						<SettingsFormActions>
							<Button variant="primary" disabled={busy || !dirty || !domain.trim() || !dnsRecord || !settings.custom.caddyInstalled || !settings.canManage} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={onSaveManual}>
								{action === "save" ? "Saving…" : "Save app domain"}
							</Button>
						</SettingsFormActions>
						<SettingsHint>Only use this when existing infrastructure already issues and renews the certificate.</SettingsHint>
					</div>
				</details>
			</SettingsForm>
		</>
	);
}

export function IngressPanel({
	onboarding = false,
	onChanged,
	onStatusChange,
	setup: parentSetup,
}: {
	onboarding?: boolean;
	onChanged?: () => void | Promise<void>;
	onStatusChange?: (settings: PublicIngressSettings) => void;
	setup?: SetupController;
} = {}) {
	const localSetup = useSetupStatus();
	const setup = parentSetup || localSetup;
	const [settings, setSettings] = useState<PublicIngressSettings | null>(null);
	const [surface, setSurface] = useState<"domain" | "callbacks">("domain");
	const [method, setMethod] = useState<IngressExposure>("custom");
	const [appDomain, setAppDomain] = useState("");
	const [certificateEmail, setCertificateEmail] = useState("");
	const [privateApiToken, setPrivateApiToken] = useState("");
	const [privateProvider, setPrivateProvider] = useState<"cloudflare" | "vercel">("cloudflare");
	const [vercelTeamId, setVercelTeamId] = useState("");
	const [privateAction, setPrivateAction] = useState<"setup" | "verify" | "save" | null>(null);
	const [drafts, setDrafts] = useState<Record<IngressExposure, string>>(EMPTY_DRAFTS);
	const [tunnelId, setTunnelId] = useState("");
	const [tunnelToken, setTunnelToken] = useState("");
	const [publicAddress, setPublicAddress] = useState("");
	const [busy, setBusy] = useState<"app" | "apply" | "test" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tailscaleApprovalUrl, setTailscaleApprovalUrl] = useState<string | null>(null);
	const loaded = useRef(false);
	const customDraftTouched = useRef(false);
	const url = drafts[method];

	function apply(next: PublicIngressSettings, selectConfigured = true) {
		setSettings(next);
		onStatusChange?.(next);
		if (!loaded.current) {
			setAppDomain(configuredAppDomain(next));
			setPrivateProvider(next.app.domain.dnsProvider || "cloudflare");
			if (onboarding && next.app.domain.health === "ready") setSurface("callbacks");
			setDrafts(configuredIngressDrafts(next));
			setPublicAddress(next.server.ipv4[0] || next.server.ipv6[0] || "");
			loaded.current = true;
		} else {
			const saved = configuredIngressDrafts(next);
			setDrafts((current) => ({
				...current,
				...(next.exposure ? { [next.exposure]: saved[next.exposure] } : {}),
				...(configuredAppDomain(next) && next.exposure !== "cloudflare" ? { cloudflare: saved.cloudflare } : {}),
				...(!customDraftTouched.current ? { custom: saved.custom } : {}),
			}));
		}
		if (selectConfigured) {
			setMethod(next.exposure || (next.tailscale.installed ? "tailscale" : "custom"));
			setTunnelId(next.cloudflare.tunnelId);
			setTunnelToken("");
		}
	}

	const applyFromEffect = useEffectEvent(apply);

	useEffect(() => {
		void fetchPublicIngress().then((next) => applyFromEffect(next)).catch((cause: unknown) => {
			setError(cause instanceof Error ? cause.message : "Couldn’t load public ingress");
		});
	}, []);

	// Ingress setup can complete before public DNS or an edge route converges.
	// Keep pending and transiently unreachable states current without requiring
	// a repeated manual probe.
	useEffect(() => {
		const publicPending = settings?.health === "starting" || settings?.health === "waiting_dns" || settings?.health === "unreachable";
		const appPending = settings?.app.domain.health === "waiting_dns" || settings?.app.domain.health === "unreachable";
		if (!publicPending && !appPending) return;
		const timer = window.setInterval(() => {
			void fetchPublicIngress().then((next) => applyFromEffect(next, false)).catch(() => {});
		}, 5_000);
		return () => window.clearInterval(timer);
	}, [settings?.health, settings?.app.domain.health]);

	async function run(
		kind: "apply" | "test",
		work: () => Promise<PublicIngressSettings>,
		message: string | ((next: PublicIngressSettings) => string),
	) {
		if (busy) return;
		setBusy(kind);
		setError(null);
		if (kind === "apply") setTailscaleApprovalUrl(null);
		await work()
			.then((next) => {
				apply(next);
				toast(typeof message === "function" ? message(next) : message, { variant: "success" });
				if (next.githubWebhook?.updated) {
					toast("GitHub callbacks connected", { variant: "success" });
				} else if (next.githubWebhook?.error) {
					toast("Public callbacks are ready, but the GitHub webhook needs attention.");
				}
				void onChanged?.();
			})
			.catch((cause: unknown) => {
				if (cause instanceof ApiError && cause.actionUrl) {
					setTailscaleApprovalUrl(cause.actionUrl);
					return;
				}
				setError(cause instanceof Error ? cause.message : "Public callbacks could not be updated");
			})
			.finally(() => setBusy(null));
	}

	async function runPrivateApp(
		action: "setup" | "save",
		work: () => Promise<PublicIngressSettings & { restartRequired: boolean }>,
		message: string | ((next: PublicIngressSettings) => string),
	) {
		if (busy || !settings) return;
		setBusy("app");
		setPrivateAction(action);
		setError(null);
		await work()
			.then((next) => {
				apply(next);
				setPrivateApiToken("");
				if (next.restartRequired) setup.requireRestart();
				const notice = typeof message === "function" ? message(next) : message;
				toast(notice, { variant: next.app.domain.health === "ready" ? "success" : "default" });
				void onChanged?.();
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : "Private app domain could not be updated");
			})
			.finally(() => { setBusy(null); setPrivateAction(null); });
	}

	async function verifyAppDomain() {
		if (busy || !settings) return;
		setBusy("app");
		setPrivateAction("verify");
		setError(null);
		await testPrivateAppDomain()
			.then((domain) => {
				setSettings((current) => current ? { ...current, app: { ...current.app, domain } } : current);
				toast(domain.health === "ready" ? "Private address is reachable" : "Private address is not ready yet", { variant: domain.health === "ready" ? "success" : "default" });
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Private app domain could not be verified"))
			.finally(() => { setBusy(null); setPrivateAction(null); });
	}

	async function applyMethod() {
		if (method === "tailscale") {
			await run("apply", enablePublicIngressFunnel, "Tailscale Funnel configured");
			return;
		}
		if (method === "custom") {
			await run(
				"apply",
				() => installPublicIngressCaddy(url, publicAddress.trim() || undefined),
				(next) => next.health === "ready" ? "Public callbacks are ready" : "Caddy configured. Waiting for DNS",
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

	const records = settings ? customDnsRecords(settings, drafts.custom, publicAddress) : [];
	const missingTool = settings && (
		(method === "tailscale" && !settings.tailscale.installed) ||
		(method === "cloudflare" && !settings.cloudflare.installed) ||
		(method === "custom" && !settings.custom.caddyInstalled)
	);
	const invalidInput =
		method !== "tailscale" && !url.trim() ||
		method === "custom" && records.length === 0 ||
		method === "cloudflare" && (!tunnelId.trim() || (!tunnelToken.trim() && !settings?.cloudflare.tokenConfigured));
	const selectedMethod = INGRESS_METHODS.find((option) => option.value === method)!;
	const selectedHealth = settings?.exposure === method ? settings.health : "not_configured";
	const selectedPublicUrl = settings ? publicUrlForMethod(settings, method, url) : "";
	const privateDomain = settings ? configuredAppDomain(settings) : "";

	return (
		<SettingsPanel className={onboarding ? "mx-auto max-w-[1120px]" : "relative"}>
			{!onboarding && (
				<SettingsHeader
					title="Domains and callbacks"
					description="Set a friendly private address, then add the public endpoint external services need."
				/>
			)}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			{!settings ? (
				<SettingCardSkeleton rows={3} label="Loading public ingress" />
			) : (
				<>
					<DomainSetupSteps
						value={surface}
						onValueChange={setSurface}
						appStatus={settings.app.domain.health}
						callbackStatus={settings.health}
					/>
					{surface === "domain" ? (
						<>
							<PrivateAppSetup
								settings={settings}
								domain={appDomain}
								onboarding={onboarding}
								email={certificateEmail}
								apiToken={privateApiToken}
								provider={privateProvider}
								teamId={vercelTeamId}
								busy={busy === "app"}
								action={privateAction}
								onDomainChange={(value) => { setAppDomain(value); setError(null); }}
								onEmailChange={setCertificateEmail}
								onTokenChange={setPrivateApiToken}
								onProviderChange={(value) => { setPrivateProvider(value); setPrivateApiToken(""); }}
								onTeamIdChange={setVercelTeamId}
								onSetup={() => void runPrivateApp("setup", () => setupPrivateAppDomain({
									domain: appDomain,
									provider: privateProvider,
									...(certificateEmail ? { email: certificateEmail } : {}),
									...(privateApiToken ? { apiToken: privateApiToken } : {}),
									...(privateProvider === "vercel" && vercelTeamId ? { teamId: vercelTeamId } : {}),
								}), (next) => next.app.domain.health === "ready" ? "Private app domain is ready" : "Private app domain configured. Verification is still pending")}
								onVerify={() => void verifyAppDomain()}
								onSaveManual={() => void runPrivateApp("save", () => savePrivateAppDomain(appDomain), "Private app domain saved")}
							/>
						</>
					) : (
					<>
					{!onboarding && (
						<>
							<SettingsGroupLabel
								actions={<StatusChip label={busy === "apply" ? "Setting up" : ingressHealthLabel(selectedHealth)} dot={busy === "apply" ? "var(--yellow)" : ingressHealthDot(selectedHealth)} />}
							>
								Status
							</SettingsGroupLabel>
							<SettingCard>
								<SettingRow>
									<SettingRowText>
										<SettingRowTitle>Public URL</SettingRowTitle>
										<SettingRowDescription className="selectable break-all font-mono">
											{selectedPublicUrl || "No public origin configured"}
										</SettingRowDescription>
									</SettingRowText>
								</SettingRow>
								<SettingRow>
									<SettingRowText>
										<SettingRowTitle>Public services</SettingRowTitle>
										<SettingRowDescription>Webhooks, remote Sandbox callbacks, and workload identity. Never the app.</SettingRowDescription>
									</SettingRowText>
								</SettingRow>
							</SettingCard>
						</>
					)}

					<div
						className={cn(
							"grid items-start gap-3.5 phone:grid-cols-1",
							onboarding
								? "grid-cols-2"
								: "grid-cols-[minmax(0,300px)_minmax(0,1fr)]",
						)}
					>
						<SettingsForm className={cn("m-0 min-w-0 gap-2", onboarding && "gap-2.5 p-6 phone:p-4")}>
							<div className="px-1 text-label font-medium text-dim">Connection method</div>
							<RadioGroup
								aria-label="Public callback method"
								value={method}
								disabled={!!busy || !settings.canManage}
								onValueChange={(next) => setMethod(next as IngressExposure)}
								className="grid gap-2"
							>
								{INGRESS_METHODS.map((option) => (
									<label
										key={option.value}
										className={cn(
											"flex min-h-20 cursor-pointer items-center gap-3.5 rounded-xl px-4 py-3.5 transition-[background-color] hover:bg-hover [&:has([data-checked])]:bg-pressed",
											onboarding && "bg-hover/50 hover:bg-hover",
										)}
									>
										<MethodMark method={option.value} />
										<span className="min-w-0 flex-1">
											<span className="block text-item-title font-medium text-fg">{option.label}</span>
											<span className="mt-1 block text-supporting text-dim">{option.description}</span>
										</span>
										<Radio
											value={option.value}
											className={cn(
												"shrink-0",
												onboarding && "size-5 border-0 bg-fg/15 data-[checked]:bg-fg data-[checked]:hover:border-fg [&>span]:hidden",
											)}
										/>
									</label>
								))}
							</RadioGroup>
						</SettingsForm>

						<SettingsForm className={cn("m-0 min-w-0", onboarding && "p-6 phone:p-4")}>
							<div className="flex items-center gap-3">
								<MethodMark method={method} size={40} />
								<div className="min-w-0">
									<div className="text-item-title font-semibold text-fg">{selectedMethod.label}</div>
									<p className="mt-0.5 mb-0 text-supporting leading-relaxed text-dim">{selectedMethod.description}</p>
								</div>
							</div>
							<div className="grid min-w-0 content-start gap-3.5">
							{method === "tailscale" && (
								<SetupSteps>
									<SetupStep number={1} title="Connect this server to Tailscale">
										<p className="m-0">The server must have a Tailscale DNS name. Funnel may also need to be allowed in your tailnet policy.</p>
										{!settings.tailscale.installed && <CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --no-onboard"}</CodeBlock>}
										<CodeBlock>sudo tailscale up</CodeBlock>
									</SetupStep>
									<SetupStep number={2} title="Start Funnel">
										<p className="m-0">Open Session sends public HTTPS traffic only to its isolated listener. No DNS records or inbound ports are needed.</p>
										<SettingsField className="mb-0">
											Public URL
											<Input value={settings.tailscale.suggestedUrl} readOnly className="font-mono" placeholder="Connect Tailscale to discover the URL" />
										</SettingsField>
										<p className="m-0">A CNAME cannot replace this address because Funnel’s certificate and routing use the .ts.net hostname. For your own domain, use Cloudflare Tunnel or Direct HTTPS with Caddy.</p>
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
									<SetupSteps>
										<SetupStep number={1} title="Create a remotely managed tunnel">
											<p className="m-0">In Cloudflare Zero Trust, open <strong className="font-medium text-fg">Networks → Connectors → Cloudflare Tunnels</strong> and create a Cloudflared tunnel.</p>
											<a className="w-fit text-link hover:underline" href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Open Cloudflare Zero Trust</a>
											<p className="m-0">Use the dashboard rather than <code>cloudflared tunnel create</code>. Connector tokens require a remotely managed tunnel.</p>
										</SetupStep>
										<SetupStep number={2} title="Add the callback route">
											<SettingsField className="mb-0">
												Public URL
												<Input key={method} type="url" value={url} placeholder="https://ingress.example.com" disabled={!!busy} readOnly={!!privateDomain} onChange={(event) => setDrafts((current) => ({ ...current, cloudflare: event.target.value }))} />
											</SettingsField>
											{privateDomain && <p className="m-0">Open Session uses a separate <strong className="font-medium text-fg">ingress</strong> hostname alongside the private app address.</p>}
											<p className="m-0">Under <strong className="font-medium text-fg">Published application routes</strong>, add <strong className="font-medium text-fg">{ingressHostname(url)}</strong> and point its HTTP service to:</p>
											<CodeBlock>{settings.cloudflare.connectorTarget}</CodeBlock>
											<p className="m-0">Cloudflare creates the DNS route. Never point this public hostname at the private app port.</p>
										</SetupStep>
										<SetupStep number={3} title="Connect this server">
											<p className="m-0">Copy the tunnel ID and connector token from that same tunnel. Open Session protects the token on this server and starts cloudflared for you.</p>
											<SettingsField className="mb-0">
												Tunnel ID
												<Input value={tunnelId} placeholder="00000000-0000-0000-0000-000000000000" disabled={!!busy} className="font-mono" onChange={(event) => setTunnelId(event.target.value)} />
											</SettingsField>
											<SettingsField className="mb-0">
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
										</SetupStep>
									</SetupSteps>
									{settings.cloudflare.connectorRunning && <StatusChip label="Connector process running" dot="var(--green)" />}
								</>
							)}

							{method === "custom" && (
								<>
									<SetupSteps>
										<SetupStep number={1} title="Choose a separate public domain">
											<SettingsField className="mb-0">
												Domain
												<Input key={method} value={url} placeholder="ingress.example.com" disabled={!!busy} autoCapitalize="none" spellCheck={false} onChange={(event) => { customDraftTouched.current = true; setDrafts((current) => ({ ...current, custom: event.target.value })); }} />
											</SettingsField>
											<p className="m-0">Do not use the private app hostname. HTTPS is added automatically.</p>
										</SetupStep>
										<SetupStep number={2} title="Open ports 80 and 443">
											<p className="m-0">Allow inbound TCP traffic from the public internet to ports 80 and 443 in the server firewall and your cloud security group. Caddy uses port 80 for certificate validation and serves HTTPS on port 443.</p>
										</SetupStep>
										<SetupStep number={3} title="Add DNS records at your provider">
											<p className="m-0">Point the domain to this server’s public IP address, not its private or Tailscale address.</p>
											<SettingsField className="mb-0">
												Public IPv4 or IPv6 address
												<Input value={publicAddress} placeholder="203.0.113.10" disabled={!!busy} autoCapitalize="none" spellCheck={false} onChange={(event) => { setPublicAddress(event.target.value); setError(null); }} />
											</SettingsField>
											{records.length ? records.map((record) => <CodeBlock key={record}>{record}</CodeBlock>) : (
												<InlineAlert>Enter this server’s public address to generate the DNS record.</InlineAlert>
											)}
										</SetupStep>
										<SetupStep number={4} title="Configure Caddy">
											<p className="m-0">Open Session adds this dedicated site to /etc/caddy/Caddyfile, binds it to the public-facing network interface, and reloads Caddy. If DNS is still propagating, the status stays at Waiting for DNS and checks again automatically.</p>
											{!settings.custom.caddyInstalled && <CodeBlock>{"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --caddy --no-onboard"}</CodeBlock>}
										</SetupStep>
									</SetupSteps>
									<details className="text-meta text-dim">
										<summary className="cursor-pointer font-medium text-fg">Caddy route preview</summary>
										<div className="mt-2"><ConfigCodeBlock code={customCaddyConfig(url)} /></div>
										<p className="mt-2 mb-0">Automatic setup also adds the detected local interface bind.</p>
									</details>
								</>
							)}
							</div>

							{settings.exposure === method && (
								<IngressWaitingState method={method} health={settings.health} />
							)}
							{method === "tailscale" && tailscaleApprovalUrl && (
								<InlineAlert variant="info" title="Approve Funnel in Tailscale">
									Approve public access, return here, then start Funnel again.
									{" "}<a className="font-medium underline underline-offset-2" href={tailscaleApprovalUrl} target="_blank" rel="noreferrer">Open Tailscale approval</a>
								</InlineAlert>
							)}
							{settings.health === "unreachable" && settings.exposure === method && (
								<InlineAlert>
									{method === "cloudflare" && settings.cloudflare.connectorRunning
										? <>The connector process is running, but Cloudflare cannot reach Open Session. Verify that this hostname routes to <strong>{settings.cloudflare.connectorTarget}</strong> and that the tunnel ID and token come from the same remotely managed tunnel.</>
										: method === "tailscale"
											? settings.tailscale.funnelConfigured
												? "Funnel is configured, but its public address did not become reachable. Check this node’s Funnel access in Tailscale, then try again."
												: "Tailscale no longer has the Funnel route for Open Session. Start Funnel again."
											: "The public URL is configured but its health check is not reachable. Verify DNS and firewall rules, then check again."}
								</InlineAlert>
							)}

							<SettingsFormActions className="phone:flex-col-reverse">
								<Button variant="soft" disabled={!!busy || !settings.canManage || settings.exposure !== method || !settings.publicBaseUrl} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={() => void run("test", testPublicIngress, (next) => next.health === "ready" ? "Public callbacks are reachable" : "Public callbacks are not ready yet") }>
									{busy === "test" ? "Checking…" : settings.health === "waiting_dns" ? "Check again" : "Test connection"}
								</Button>
								<Button variant="primary" disabled={!!busy || !settings.canManage || !!missingTool || invalidInput} className="phone:min-h-11 phone:w-full phone:justify-center" onClick={() => void applyMethod()}>
									{busy === "apply" ? "Setting up…" : method === "tailscale" ? "Start Funnel" : method === "custom" ? settings.exposure === "custom" ? "Update Caddy" : "Configure Caddy" : "Start tunnel"}
								</Button>
							</SettingsFormActions>
							<div className="border-t border-line pt-3.5">
								<div className="text-item-title font-medium text-fg">Private by default</div>
								<p className="mt-1 mb-0 text-supporting leading-relaxed text-dim">
									Unknown methods and paths return 404. This endpoint never serves sessions, APIs, or the app UI.
								</p>
							</div>
						</SettingsForm>
					</div>
					</>
					)}
					{!onboarding && <SetupRestart setup={setup} />}
				</>
			)}
		</SettingsPanel>
	);
}
