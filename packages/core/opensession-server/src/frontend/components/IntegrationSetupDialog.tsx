import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Disclosure } from "../ui/disclosure";
import { Modal } from "../ui/modal";
import { SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { WEBHOOK_BASE_URL } from "../lib/brand";
import { SLACK_SCOPE_GROUPS } from "../lib/slack-manifest";
import {
	publicWebhookAvailable,
	savedSlackTransport,
	slackCredentialRequired,
	type SlackTransport,
} from "../lib/slack-setup";
import { IconTile } from "./BrandTile";
import { SlackManifestGuide } from "./SlackManifestGuide";
import {
	Code,
	CopyableCode,
	GuideBlock,
	LinkChips,
	ScopeGroups,
	SecretField,
	SetupSteps,
	setupRequest,
	type SetupIntegration,
	type SetupScopeGroup,
} from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps , mergeStylexClassName} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mt15: {
			marginTop: "6px"
	},
	block: {
			display: "block"
	},
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap25: {
			gap: "10px"
	},
	p4: {
			padding: "16px"
	},
	gap4: {
			gap: "16px"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "2px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	minW12rem: {
			minWidth: "12rem"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	mt3: {
			marginTop: "12px"
	},
	m0: {
			margin: "0"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	mt0: {
			marginTop: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	mt25: {
			marginTop: "10px"
	},
	gap15: {
			gap: "6px"
	},
	pl5: {
			paddingLeft: "20px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	p3: {
			padding: "12px"
	},
	withDivider: {
		marginTop: "16px",
		borderTopStyle: "solid",
		borderTopWidth: "1px",
		borderColor: "var(--border)",
		paddingTop: "16px",
	},
	envFields: {
		display: "flex",
		flexDirection: "column",
		gap: "16px",
	},

	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	phoneFlex1: {
		"@media (max-width: 720px)": {
			"flex": "1"
		}
	},

	phoneMl0: {
		"@media (max-width: 720px)": {
			"marginLeft": "0"
		}
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
});

// One integration's whole configuration, in the order you work through it:
// the switch and the credential fields first, the provider's recipe behind a
// disclosure under them. It used to run the other way — five numbered steps
// and four paragraphs of scopes ahead of the form — so anyone opening the
// dialog a second time scrolled past a page of documentation to reach the two
// fields they came for, and on a laptop the first field was below the fold.

function Value({ value }: { value: string }) {
	return (
		<span {...stylex.props(sx.mt15, sx.block)}>
			<CopyableCode value={value} />
		</span>
	);
}

type Guide = {
	description: string;
	/** Rendered above the numbered steps, for a provider that can be set up
	 *  from generated config rather than transcription — Slack's manifest. */
	intro?: ReactNode;
	steps: ReactNode[];
	/** Permission tokens you transcribe into the provider's own form. Data,
	 *  rather than bold runs inside a sentence — see ScopeGroups. */
	scopes?: SetupScopeGroup[];
	/** One line that finishes the scope list, for the thing a person looking at
	 *  it wonders next ("do I need file access?"). */
	scopesNote?: ReactNode;
	permissions?: ReactNode[];
	note?: ReactNode;
};

function endpoint(publicBaseUrl: string, path: string): string {
	return `${publicBaseUrl.replace(/\/$/, "")}${path}`;
}

function guideFor(
	integration: SetupIntegration,
	publicBaseUrl: string,
	transport: SlackTransport,
): Guide {
	const url = (path: string) => endpoint(publicBaseUrl, path);

	switch (integration.id) {
		case "plain":
			return {
				description: "Connect a Plain machine user and send support webhooks to Open Session.",
				steps: [
					<>In Plain, create a machine user and generate its API key.</>,
					<>
						Create a webhook for <strong>thread created</strong>, <strong>thread status transitioned</strong>, and <strong>thread note created</strong>. Use this endpoint:
						<Value value={url("/plain/webhook")} />
					</>,
					<>Paste the API key and webhook signing secret into the fields above.</>,
					<>Enable Plain, save, and restart Open Session. Then send a test webhook from Plain.</>,
				],
				permissions: [
					<>Give the machine user access to read threads and create internal notes.</>,
					<>Keep customer replies human-controlled; the built-in triage flow writes an internal note, not a customer reply.</>,
				],
			};

		case "linear":
			return {
				description: "Create a Linear app that can receive agent assignments and work with issues.",
				steps: [
					<>Create an OAuth application in Linear and enable its app/agent actor capability.</>,
					<>
						Set the OAuth callback URL to exactly:
						<Value value={url("/oauth/callback")} />
					</>,
					<>
						Create a Linear webhook for agent-session and issue events. Use this endpoint:
						<Value value={url("/webhook")} />
					</>,
					<>Paste the client id, client secret, webhook secret, and API key into the fields above.</>,
					<>Enable Linear, save, restart Open Session, then install and authorize the app in your workspace.</>,
				],
				scopes: [{ label: "OAuth scopes", items: ["app:assignable", "read", "write"] }],
				permissions: [
					<>The optional API key is used for direct issue reads and writes when no stored OAuth grant is available.</>,
				],
			};

		case "slack": {
			const socket = transport === "socket";
			return {
				description: "Create a Slack bot for DMs, mentions, session channels, and interactive controls.",
				intro: <SlackManifestGuide transport={transport} />,
				steps: [
					<>Create the app from the manifest above, then install it to your workspace.</>,
					socket ? (
						<>
							Open <strong>Basic Information → App-Level Tokens</strong>, generate a token with the <strong>connections:write</strong> scope, and paste the <Code>xapp-</Code> value into <Code>SLACK_APP_TOKEN</Code> above.
						</>
					) : (
						<>
							Copy the signing secret from <strong>Basic Information</strong> into <Code>SLACK_SIGNING_SECRET</Code> above. The manifest already includes the event and interactivity request URLs.
						</>
					),
					<>Copy the bot token from <strong>OAuth &amp; Permissions</strong> after installing, and set an allowed Slack user id so admin tools are not open to every workspace member.</>,
					<>Enable Slack, save, restart Open Session, and invite the bot to every existing channel it should read.</>,
				],
				// Same list the manifest carries, so the chips and the generated app
				// can never drift apart. Keep it visible for someone reviewing an
				// existing app rather than creating a new one.
				scopes: SLACK_SCOPE_GROUPS,
				scopesNote: socket ? (
					<>The manifest grants all of these. The app-level token only needs <strong>connections:write</strong>.</>
				) : (
					<>The manifest grants all of these and enables interactivity.</>
				),
			};
		}

		case "stripe":
			return {
				description: "Receive dispute events from Stripe and route them into a scoped automation.",
				steps: [
					<>
						Create a Stripe webhook endpoint at:
						<Value value={url("/stripe/webhook")} />
					</>,
					<>Subscribe it only to <strong>charge.dispute.created</strong>.</>,
					<>Reveal the endpoint signing secret and paste it into the field above.</>,
					<>Enable Stripe, save, restart Open Session, then send a test dispute event.</>,
				],
				permissions: [
					<>The webhook integration needs no Stripe API key; it only verifies and receives the selected event.</>,
					<>If you separately connect Stripe MCP, use a restricted key with read access to the billing data you need and only the narrow write permissions you explicitly intend.</>,
				],
				note: <>Money-moving Stripe tools remain unavailable to agent runs even when the MCP server has a write-capable key.</>,
			};

		case "grafana":
			return {
				description: "Let Open Session query Loki for failure signatures and start investigation automations.",
				steps: [
					<>Create a Grafana service account dedicated to Open Session.</>,
					<>Generate a service-account token and copy your Grafana base URL.</>,
					<>Paste both values above. If your Loki datasource is not named <strong>loki</strong>, also enter its datasource UID.</>,
					<>Enable the poller, save, restart Open Session, then configure a Grafana poll on the automation that should investigate matches.</>,
				],
				permissions: [
					<>Grant only enough Grafana access to query the selected Loki datasource.</>,
					<>No Grafana admin or dashboard-write permission is needed.</>,
				],
			};

		case "github":
			return {
				description: "Connect the machine user that handles PR comments, reviews, webhooks, and fallback PR authorship.",
				steps: [
					<>Create a dedicated GitHub machine user and give it access to the repositories Open Session works in.</>,
					<>Create a fine-grained personal access token for that user and paste it into the fields above.</>,
					<>On the Open Session host, sign the GitHub CLI into the same machine user with <strong>gh auth login</strong>. CLI authentication is separate from the token above.</>,
					<>
						Add a repository or organization webhook with content type <strong>application/json</strong> and this payload URL:
						<Value value={url("/github/webhook")} />
					</>,
					<>Create a webhook secret, paste it both into GitHub and into the fields above, then enter the bot login and any @handles that should wake the PR agent.</>,
					<>Enable GitHub, save, restart Open Session, and send a webhook test delivery.</>,
				],
				permissions: [
					<>Fine-grained token: <strong>Pull requests: read and write</strong> and <strong>Issues: read and write</strong> for only the target repositories.</>,
					<>The machine user and gh CLI need repository write access; add merge permission only if you use the UI&rsquo;s merge flows.</>,
					<>Webhook events: issue comments, pull requests, pull-request reviews and review comments, and workflow runs.</>,
				],
			};

		case "codestorage":
			return {
				description: "Connect a code.storage organization with a local signing key instead of a long-lived token.",
				steps: [
					<>Create or choose your organization in code.storage.</>,
					<>Generate a PKCS8 ES256 or RS256 keypair. Register the public key with the organization and keep the private key on this Open Session host.</>,
					<>Open <strong>Workspace → Connections</strong>, choose Code Storage, enter the organization id, and paste the private key. Open Session stores it with mode 0600 and verifies the connection.</>,
					<>Register or clone a code.storage repository from the Repositories setup page.</>,
				],
				permissions: [
					<>The registered organization key must allow Git read and write for the repositories Open Session will use.</>,
					<>There are no user seats, OAuth grants, or personal access tokens to configure.</>,
				],
			};

		default:
			return {
				description: `Connect ${integration.label} to Open Session.`,
				steps: [
					<>Create the provider credentials linked below.</>,
					<>Paste each value into its matching field above.</>,
					<>Enable the integration, save, and restart Open Session.</>,
				],
			};
	}
}

export function IntegrationSetupDialog({
	integration,
	open,
	onOpenChange,
	onSaved,
}: {
	integration: SetupIntegration;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
}) {
	const [enabled, setEnabled] = useState(integration.enabled);
	const [typed, setTyped] = useState<Record<string, string>>({});
	const [cleared, setCleared] = useState<Record<string, boolean>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [transport, setTransport] = useState<SlackTransport>(() =>
		savedSlackTransport(integration.env),
	);
	const guide = guideFor(integration, WEBHOOK_BASE_URL, transport);
	const httpAvailable = publicWebhookAvailable(WEBHOOK_BASE_URL);

	// Cancel discards a transport change just like it discards typed credentials.
	useEffect(() => {
		if (!open) return;
		setEnabled(integration.enabled);
		setTyped({});
		setCleared({});
		setError(null);
		setTransport(savedSlackTransport(integration.env));
	}, [open, integration]);

	function pickTransport(next: SlackTransport) {
		setTransport(next);
		setTyped((current) => ({ ...current, SLACK_APP_TOKEN: "" }));
		setCleared((current) => ({ ...current, SLACK_APP_TOKEN: next === "http" }));
	}

	const hiddenEnvKey =
		integration.id === "slack"
			? transport === "socket"
				? "SLACK_SIGNING_SECRET"
				: "SLACK_APP_TOKEN"
			: null;
	const visibleEnv = hiddenEnvKey
		? integration.env.filter((envVar) => envVar.name !== hiddenEnvKey)
		: integration.env;

	const typedKeys = integration.env
		.map((envVar) => envVar.name)
		.filter((name) => (typed[name] ?? "").trim() !== "");
	const clearedKeys = integration.env
		.filter(
			(envVar) =>
				envVar.present && cleared[envVar.name] && !(typed[envVar.name] ?? "").trim(),
		)
		.map((envVar) => envVar.name);
	const dirty =
		enabled !== integration.enabled || typedKeys.length > 0 || clearedKeys.length > 0;

	// Code Storage is configured under Workspace → Connections, so this dialog
	// documents it rather than switching it on — the same carve-out the
	// integration card makes.
	const canToggle = integration.id !== "codestorage";
	const configured = integration.env.some((envVar) => envVar.present);

	async function save() {
		if (!dirty || saving) return;
		setSaving(true);
		setError(null);
		await (async () => {
const env: Record<string, string> = {};
			for (const name of typedKeys) env[name] = (typed[name] ?? "").replace(/\s+/g, "");
			for (const name of clearedKeys) env[name] = "";
			const body = await setupRequest<{
				integration: SetupIntegration;
				restartRequired: boolean;
			}>(`/api/setup/integrations/${encodeURIComponent(integration.id)}`, {
				method: "PUT",
				json: {
					...(enabled !== integration.enabled ? { enabled } : {}),
					...(Object.keys(env).length > 0 ? { env } : {}),
				},
			});
			setTyped({});
			setCleared({});
			toast(`${integration.label} saved`);
			onSaved(body.integration, body.restartRequired !== false);
			onOpenChange(false);
})().catch(async (cause) => {
setError(cause instanceof Error ? cause.message : `Could not save ${integration.label}`);
}).finally(async () => {
setSaving(false);
});
	}

	return (
		<Modal.Root open={open} onOpenChange={onOpenChange}>
			<Modal.Content widthClassName="max-w-[34rem]">
				<Modal.Header
					title={
						<span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
							<IconTile name={integration.id} size={28} />
							{integration.label}
						</span>
					}
					description={guide.description}
				/>

				{(canToggle || integration.env.length > 0) && (
					<SettingsSection {...stylex.props(sx.p4)}>
						{canToggle && (
							<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap4)}>
								<div {...stylex.props(sx.minW0, sx.flex1)}>
									<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>
										Enable {integration.label}
									</div>
									<div {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}>
										Takes effect after you restart Open Session.
									</div>
								</div>
								<Switch
									checked={enabled}
									onCheckedChange={setEnabled}
									disabled={saving}
									aria-label={`Enable ${integration.label}`}
								/>
							</div>
						)}
						{integration.id === "slack" && (
							<div {...stylex.props(canToggle && sx.withDivider)}>
								<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap4)}>
									<div {...stylex.props(sx.minW12rem, sx.flex1)}>
										<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>Event delivery</div>
										<div {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}>
											{transport === "socket"
												? "Uses an outbound connection and needs no public webhook URL."
												: "Slack posts events to this instance's public webhook URL."}
										</div>
									</div>
									<Segmented
										label="Slack event delivery"
										value={transport}
										onValueChange={(next) => pickTransport(next as SlackTransport)} {...mergeStylexProps("", sx.phoneMl0, sx.phoneWFull, sx.mlAuto)}
									>
										<SegmentedOption value="socket" disabled={saving} className={mergeStylexClassName("", sx.phoneMinH11, sx.phoneFlex1)}>
											Socket Mode
										</SegmentedOption>
										<SegmentedOption value="http" disabled={saving || !httpAvailable} className={mergeStylexClassName("", sx.phoneMinH11, sx.phoneFlex1)}>
											HTTP
										</SegmentedOption>
									</Segmented>
								</div>
								{transport === "http" && !httpAvailable && (
									<InlineAlert variant="warn" {...stylex.props(sx.mt3)}>
										This instance has no public webhook URL. Choose Socket Mode or configure a public URL first.
									</InlineAlert>
								)}
							</div>
						)}
						{visibleEnv.length > 0 && (
							<div {...stylex.props(sx.envFields, canToggle && sx.withDivider)}>
								{visibleEnv.map((envVar) => (
									<SecretField
										key={envVar.name}
										name={envVar.name}
										label={<Code>{envVar.name}</Code>}
										description={envVar.description}
										present={envVar.present}
										required={
											integration.id === "slack"
												? slackCredentialRequired(envVar.name, envVar.required, transport)
												: envVar.required
										}
										disabled={saving}
										cleared={Boolean(
											envVar.present &&
												cleared[envVar.name] &&
												!(typed[envVar.name] ?? "").trim(),
										)}
										value={typed[envVar.name] ?? ""}
										onChange={(value) => {
											setTyped((current) => ({ ...current, [envVar.name]: value }));
											if (value.trim() && cleared[envVar.name]) {
												setCleared((current) => ({ ...current, [envVar.name]: false }));
											}
										}}
										onToggleClear={() => {
											setCleared((current) => ({
												...current,
												[envVar.name]: !current[envVar.name],
											}));
											setTyped((current) => ({ ...current, [envVar.name]: "" }));
										}}
									/>
								))}
								<p {...stylex.props(sx.m0, sx.textFaint, typography.supporting)}>
									Credentials stay on this server and are never shown back.
								</p>
							</div>
						)}
					</SettingsSection>
				)}

				{/* Open on a first setup, closed once there are credentials to keep:
				    the recipe is a one-time read, the fields are not. */}
				<Disclosure
					title="Setup guide"
					defaultOpen={!configured}
					actions={<LinkChips links={integration.links} {...stylex.props(sx.mt0)} />}
				>
					<div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
						{guide.intro}
						<SetupSteps steps={guide.steps} />
						{guide.scopes && (
							<GuideBlock title="Bot scopes">
								<ScopeGroups groups={guide.scopes} />
								{guide.scopesNote && (
									<p {...stylex.props(sx.m0, sx.mt25, sx.textDim, typography.supporting)}>{guide.scopesNote}</p>
								)}
							</GuideBlock>
						)}
						{guide.permissions && (
							<GuideBlock title="Permissions">
								<ul {...stylex.props(sx.m0, sx.flex, sx.flexCol, sx.gap15, sx.pl5, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
									{guide.permissions.map((permission, index) => (
										<li key={index}>{permission}</li>
									))}
								</ul>
							</GuideBlock>
						)}
						{guide.note && (
							<div {...stylex.props(sx.roundedLg, sx.bgSurface, sx.p3, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
								{guide.note}
							</div>
						)}
					</div>
				</Disclosure>

				{error && <InlineAlert>{error}</InlineAlert>}

				{/* Nothing to change here means nothing to abandon, so the dialog
				    closes on one button rather than offering Cancel beside Done. */}
				<Modal.Footer>
					{canToggle || integration.env.length > 0 ? (
						<>
							<Modal.Close render={<Button variant="ghost" disabled={saving}>Cancel</Button>} />
							<Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
								{saving ? "Saving…" : "Save"}
							</Button>
						</>
					) : (
						<Modal.Close render={<Button variant="primary">Done</Button>} />
					)}
				</Modal.Footer>
			</Modal.Content>
		</Modal.Root>
	);
}
