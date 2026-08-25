import { useEffect, useState } from "react";
import { accessCaddyGuide } from "../lib/setup-access";
import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { Disclosure } from "../ui/disclosure";
import { Field, Input } from "../ui/input";
import { SettingsHint, SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";
import { IconCopy } from "./icons";
import {
	Code,
	GuideBlock,
	SetupSteps,
	StateChip,
	publicUrlState,
	setupRequest,
	type SetupAccess,
} from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps , mergeStylexClassName} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	m0: {
			margin: "0"
	},
	overflowXAuto: {
			overflowX: "auto"
	},
	whitespacePre: {
			whiteSpace: "pre"
	},
	p3: {
			padding: "12px"
	},
	pr20: {
			paddingRight: "80px"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textFg: {
			color: "var(--text)"
	},
	absolute: {
			position: "absolute"
	},
	right2: {
			right: "8px"
	},
	top2: {
			top: "8px"
	},
	flex: {
			display: "flex"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap5: {
			gap: "20px"
	},
	wFull: {
			width: "100%"
	},
	itemsCenter: {
			alignItems: "center"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap3: {
			gap: "12px"
	},
	mt15: {
			marginTop: "6px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	mt3: {
			marginTop: "12px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textBlue: {
			color: "var(--blue)"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gap2: {
			gap: "8px"
	},
	px2: {
			paddingInline: "8px"
	},
	py1: {
			paddingBlock: "4px"
	},

	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},

	hoverUnderline: {
		"@media (hover: hover)": {
			":hover": {
				"textDecorationLine": "underline"
			}
		}
	},
});

function CaddyConfigBlock({ value }: { value: string }) {
	const { copied, copy } = useCopy();
	return (
		<div {...stylex.props(sx.relative, sx.roundedLg, sx.bgSurface)}>
			<pre {...stylex.props(sx.m0, sx.overflowXAuto, sx.whitespacePre, sx.p3, sx.pr20, sx.fontMono, sx.leadingRelaxed, sx.textFg, typography.meta)}>
				{value}
			</pre>
			<Button
				type="button"
				variant="soft"
				size="sm" {...mergeStylexProps("", sx.phoneMinH11, sx.absolute, sx.right2, sx.top2)}
				onClick={() => copy(value, { toast: "Caddy config copied" })}
			>
				<CopyCheck copied={copied} size={14} idle={<IconCopy size={14} />} />
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

export function SetupServerAccess({
	access,
	onSaved,
}: {
	access: SetupAccess;
	onSaved: (updated: SetupAccess, restartRequired: boolean) => void;
}) {
	const [appAddress, setAppAddress] = useState(access.publicBaseUrl);
	const [webhookAddress, setWebhookAddress] = useState(
		access.webhookBaseUrl ?? "",
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setAppAddress(access.publicBaseUrl);
		setWebhookAddress(access.webhookBaseUrl ?? "");
	}, [access]);

	const dirty =
		appAddress.trim() !== access.publicBaseUrl ||
		webhookAddress.trim() !== (access.webhookBaseUrl ?? "");
	const preview = {
		...access,
		publicBaseUrl: appAddress,
		webhookBaseUrl: webhookAddress.trim() || null,
	};
	const { hosts, caddyfile } = accessCaddyGuide(preview);
	const appState = publicUrlState(appAddress);

	async function save() {
		if (!dirty || saving) return;
		setSaving(true);
		setError(null);
		await (async () => {
const result = await setupRequest<{
				access: SetupAccess;
				restartRequired: boolean;
			}>("/api/setup/access", {
				method: "PUT",
				json: {
					publicBaseUrl: appAddress,
					webhookBaseUrl: webhookAddress,
				},
			});
			onSaved(result.access, result.restartRequired !== false);
			toast("Server addresses saved", { variant: "success" });
})().catch(async (cause) => {
setError(cause instanceof Error ? cause.message : "Could not save server addresses");
}).finally(async () => {
setSaving(false);
});
	}

	return (
		<>
			<SettingsSection>
				<form
					{...stylex.props(sx.flex, sx.flexCol, sx.gap5)}
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div>
						<Field
							label={
								<span {...stylex.props(sx.flex, sx.wFull, sx.itemsCenter, sx.justifyBetween, sx.gap3)}>
									<span>App address</span>
									<StateChip tone={appState.tone} label={appState.label} />
								</span>
							}
						>
							<Input
								type="url"
								value={appAddress}
								placeholder="https://os.example.com"
								disabled={saving} {...mergeStylexProps("", sx.phoneMinH11, sx.fontMono)}
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								onChange={(event) => {
									setAppAddress(event.target.value);
									setError(null);
								}}
							/>
						</Field>
						<p {...stylex.props(sx.m0, sx.mt15, sx.leadingRelaxed, sx.textFaint, typography.supporting)}>
							Where you open Open Session. Its DNS record should point to the server&apos;s Tailscale address so the app stays private.
						</p>
					</div>

					<div>
						<Field
							label={
								<span {...stylex.props(sx.flex, sx.wFull, sx.itemsCenter, sx.justifyBetween, sx.gap3)}>
									<span>Webhook address</span>
									<StateChip
										tone={webhookAddress.trim() ? "on" : "off"}
										label={webhookAddress.trim() ? "Separate address" : "Optional"}
									/>
								</span>
							}
						>
							<Input
								type="url"
								value={webhookAddress}
								placeholder="https://hooks.example.com"
								disabled={saving} {...mergeStylexProps("", sx.phoneMinH11, sx.fontMono)}
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								onChange={(event) => {
									setWebhookAddress(event.target.value);
									setError(null);
								}}
							/>
						</Field>
						<p {...stylex.props(sx.m0, sx.mt15, sx.leadingRelaxed, sx.textFaint, typography.supporting)}>
							A public HTTPS address for GitHub and other signed webhooks. It must use a different hostname and expose only the webhook listener.
						</p>
					</div>

					{error && <InlineAlert>{error}</InlineAlert>}

					<div {...stylex.props(sx.flex, sx.justifyEnd)}>
						<Button
							type="submit"
							variant="primary"
							disabled={!dirty || saving}
							className={mergeStylexClassName("", sx.phoneMinH11)}
						>
							{saving ? "Saving…" : "Save addresses"}
						</Button>
					</div>
				</form>
			</SettingsSection>
			<SettingsHint>
				Saving updates the addresses Open Session uses in links and setup guides. DNS and Caddy are configured separately below.
			</SettingsHint>

			<SettingsSection {...stylex.props(sx.mt3)}>
				<Disclosure
					title="Configure Caddy on this server"
					defaultOpen={appState.tone !== "on" || !access.webhookBaseUrl}
					className="phone:[&_button]:min-h-11"
				>
					<div {...stylex.props(sx.flex, sx.flexCol, sx.gap5)}>
						<p {...stylex.props(sx.m0, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
							Run Caddy on the Open Session machine. It owns HTTPS and forwards to the two loopback listeners.
						</p>
						<SetupSteps
							steps={[
								<>
									Create a DNS-only A record for <strong>{hosts.app}</strong> pointing to <strong>{access.tailnetIp || "this server’s Tailscale IP"}</strong>. Keep this app address private.
								</>,
								<>
									Get and automatically renew the app certificate with a DNS-01 challenge. Place its certificate and key at the paths below so Caddy can read them.
								</>,
								...(hosts.webhook
									? [
										<>
											Create a public DNS record for <strong>{hosts.webhook}</strong> pointing to this server&apos;s public IP. Allow inbound port 443. Caddy obtains this certificate automatically.
										</>,
									]
									: [
										<>
											Add a webhook address above when GitHub or another provider needs to send events to this instance.
										</>,
									]),
								<>
									{access.caddyInstalled ? (
										"Caddy is installed on this machine. "
									) : (
										<>
											<a
												href="https://caddyserver.com/docs/install"
												target="_blank"
												rel="noreferrer" {...mergeStylexProps("", sx.hoverUnderline, sx.fontMedium, sx.textBlue)}
											>
												Install Caddy
											</a>{" "}
											on this machine. {" "}
										</>
									)}
									Add the generated site blocks to <strong>/etc/caddy/Caddyfile</strong>.
								</>,
								<>
									Validate and reload Caddy, then run <strong>opensession bind 127.0.0.1</strong>. Open the app address before closing your current tab.
								</>,
								<>
									From a device off Tailscale, confirm the app address times out.
									{hosts.webhook && (
										<> Then send a GitHub test delivery to <strong>https://{hosts.webhook}/github/webhook</strong>.</>
									)}
								</>,
							]}
						/>

						<GuideBlock title="Caddyfile">
							<CaddyConfigBlock value={caddyfile} />
						</GuideBlock>

						<GuideBlock title="Apply">
							<div {...stylex.props(sx.flex, sx.flexWrap, sx.gap2)}>
								<Code {...stylex.props(sx.px2, sx.py1, typography.meta)}>
									sudo caddy validate --config /etc/caddy/Caddyfile
								</Code>
								<Code {...stylex.props(sx.px2, sx.py1, typography.meta)}>
									sudo systemctl reload caddy
								</Code>
							</div>
						</GuideBlock>

						<p {...stylex.props(sx.m0, sx.leadingRelaxed, sx.textFaint, typography.meta)}>
							No public port 443 is available? Use a named Cloudflare Tunnel for the webhook hostname to <strong>http://127.0.0.1:{access.webhookPort}</strong>. Never point a public hostname at port {access.port}.
						</p>
					</div>
				</Disclosure>
			</SettingsSection>
		</>
	);
}
