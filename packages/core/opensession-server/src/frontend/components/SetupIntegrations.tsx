import React, { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { cn, mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";
import { Disclosure } from "../ui/disclosure";
import { Modal } from "../ui/modal";
import { SettingCard, SettingsHint, SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import {
	GuideBlock,
	LinkChips,
	SecretField,
	SetupSteps,
	StateChip,
	githubAuthState,
	integrationState,
	setupRequest,
	type SetupGithub,
	type SetupIntegration,
} from "./setup-shared";
import { IntegrationSetupDialog } from "./IntegrationSetupDialog";
import { IconTile } from "./BrandTile";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { sharedClassStyles } from "../styles/shared-class-styles.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gap3: {
			gap: "12px"
	},
	px5: {
			paddingInline: "20px"
	},
	py4: {
			paddingBlock: "16px"
	},
	minW14rem: {
			minWidth: "14rem"
	},
	flex1: {
			flex: "1"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	m0: {
			margin: "0"
	},
	mt1: {
			marginTop: "4px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt2: {
			marginTop: "8px"
	},
	textYellow: {
			color: "var(--yellow)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	minH10: {
			minHeight: "40px"
	},
	shrink0: {
			flexShrink: "0"
	},
	grid: {
			display: "grid"
	},
	gap25: {
			gap: "10px"
	},
	p4: {
			padding: "16px"
	},
	mt0: {
			marginTop: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap4: {
			gap: "16px"
	},
	gap15: {
			gap: "6px"
	},
	pl5: {
			paddingLeft: "20px"
	},
	minW0: {
			minWidth: "0"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	mt05: {
			marginTop: "2px"
	},
	mt4: {
			marginTop: "16px"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	pt4: {
			paddingTop: "16px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	gap1: {
			gap: "4px"
	},
	minH20: {
			minHeight: "80px"
	},
	wFull: {
			width: "100%"
	},
	resizeY: {
			resize: "vertical"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px25: {
			paddingInline: "10px"
	},
	py15: {
			paddingBlock: "6px"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	px4: {
			paddingInline: "16px"
	},
	gapX3: {
			columnGap: "12px"
	},
	gapY1: {
			rowGap: "4px"
	},
	colStart2: {
			gridColumnStart: "2"
	},
	rowStart2: {
			gridRowStart: "2"
	},
	mt15: {
			marginTop: "6px"
	},
	colStart3: {
			gridColumnStart: "3"
	},
	rowSpan2: {
			gridRow: "span 2/span 2"
	},
	rowStart1: {
			gridRowStart: "1"
	},
	ml4: {
			marginLeft: "16px"
	},
	hidden: {
			display: "none"
	},
	minH11: {
			minHeight: "44px"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	mt3: {
			marginTop: "12px"
	},
	gridCols2: {
			gridTemplateColumns: "repeat(2,minmax(0,1fr))"
	},
	hFull: {
			height: "100%"
	},
	mtAuto: {
			marginTop: "auto"
	},
	pt1: {
			paddingTop: "4px"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	headingRow: {
		gridColumnStart: "2",
		display: "flex",
		minWidth: 0,
		flexWrap: "wrap",
		alignItems: "center",
		gap: "8px",
	},
	selfCenter: {
		alignSelf: "center",
	},

	maxSmMinH10: {
		"@media not all and (min-width: 40rem)": {
			"minHeight": "40px"
		}
	},
	phoneHidden: {
		"@media (max-width: 720px)": {
			"display": "none"
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
	phoneJustifyCenter: {
		"@media (max-width: 720px)": {
			"justifyContent": "center"
		}
	},

	phonePx0: {
		"@media (max-width: 720px)": {
			"paddingInline": "0"
		}
	},
	gridColsAutoMinmax01frAuto: {
		"gridTemplateColumns": "auto minmax(0,1fr) auto"
	},
	phoneGridColsAutoMinmax01fr: {
		"@media (max-width: 720px)": {
			"gridTemplateColumns": "auto minmax(0,1fr)"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phonePy2: {
		"@media (max-width: 720px)": {
			"paddingBlock": "8px"
		}
	},
	phoneColSpan2: {
		"@media (max-width: 720px)": {
			"gridColumn": "span 2/span 2"
		}
	},
	phoneColStart1: {
		"@media (max-width: 720px)": {
			"gridColumnStart": "1"
		}
	},
	phoneMt3: {
		"@media (max-width: 720px)": {
			"marginTop": "12px"
		}
	},
	phoneRowSpan1: {
		"@media (max-width: 720px)": {
			"gridRow": "span 1/span 1"
		}
	},
	phoneRowStart3: {
		"@media (max-width: 720px)": {
			"gridRowStart": "3"
		}
	},
	phoneMt4: {
		"@media (max-width: 720px)": {
			"marginTop": "16px"
		}
	},
	phoneMl0: {
		"@media (max-width: 720px)": {
			"marginLeft": "0"
		}
	},
	phoneFlexCol: {
		"@media (max-width: 720px)": {
			"flexDirection": "column"
		}
	},
	phoneItemsStretch: {
		"@media (max-width: 720px)": {
			"alignItems": "stretch"
		}
	},
	phoneFlex: {
		"@media (max-width: 720px)": {
			"display": "flex"
		}
	},
	phoneGridCols1: {
		"@media (max-width: 720px)": {
			"gridTemplateColumns": "repeat(1,minmax(0,1fr))"
		}
	},
});

// The configuration forms behind the integration registry: paste the
// credentials, flip the enable switch, Save, restart. Rendered both as a Setup
// step and as the Workspace → Integrations settings page, so neither surface
// has its own idea of what an integration card looks like.

const INTEGRATION_DESCRIPTIONS: Record<string, string> = {
	plain: "Support threads, internal notes, and triage webhooks.",
	linear: "Assigned issues become scoped coding sessions.",
	slack: "DMs, mentions, session channels, and interactive controls.",
	stripe: "Dispute webhooks routed into scoped automations.",
	grafana: "Loki failure signatures routed into investigation automations.",
	github: "PR comments, reviews, webhooks, and fallback PR authorship.",
	codestorage: "Git hosting with branch-based reviews and local signing keys.",
};

function IntegrationCard({
	integration,
	onSaved,
}: {
	integration: SetupIntegration;
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
}) {
	const state = integrationState(integration);
	const [setupOpen, setSetupOpen] = useState(false);
	const [toggling, setToggling] = useState(false);
	const hasCredentials = integration.env.some((envVar) => envVar.present);
	const canToggle =
		integration.id !== "codestorage" &&
		(integration.enabled || integration.missingRequired.length === 0);

	async function toggle(enabled: boolean) {
		setToggling(true);
		await (async () => {
const body = await setupRequest<{
				integration: SetupIntegration;
				restartRequired: boolean;
			}>(`/api/setup/integrations/${encodeURIComponent(integration.id)}`, {
				method: "PUT",
				json: { enabled },
			});
			toast(`${integration.label} ${enabled ? "enabled" : "disabled"}`);
			onSaved(body.integration, body.restartRequired !== false);
})().catch(async (cause) => {
toast(cause instanceof Error ? cause.message : `Could not update ${integration.label}`, {
				variant: "error",
			});
}).finally(async () => {
setToggling(false);
});
	}

	return (
		<>
			<SettingCard>
				<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsStart, sx.gap3, sx.px5, sx.py4)}>
					<IconTile name={integration.id} size={40} />
					<div {...stylex.props(sx.minW14rem, sx.flex1)}>
						<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2)}>
							<div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>{integration.label}</div>
							<StateChip tone={state.tone} label={state.label} />
						</div>
						<p {...stylex.props(sx.m0, sx.mt1, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
							{INTEGRATION_DESCRIPTIONS[integration.id] ?? `Connect ${integration.label} to Open Session.`}
						</p>
						{integration.missingRequired.length > 0 && (
							<div {...stylex.props(sx.mt2, sx.textYellow, typography.meta)}>
								Missing {integration.missingRequired.join(", ")}
							</div>
						)}
					</div>
					<div {...stylex.props(sx.mlAuto, sx.flex, sx.minH10, sx.shrink0, sx.itemsCenter, sx.gap2)}>
						{canToggle && (
							<Switch
								checked={integration.enabled}
								onCheckedChange={(enabled) => void toggle(enabled)}
								disabled={toggling}
								aria-label={`${integration.enabled ? "Disable" : "Enable"} ${integration.label}`}
							/>
						)}
						<Button
							size="sm"
							className={mergeStylexOverrideClassName("", sx.maxSmMinH10)}
							variant={!hasCredentials && integration.env.length > 0 ? "primary" : "default"}
							onClick={() => setSetupOpen(true)}
						>
							{hasCredentials || integration.enabled ? "Configure" : "Set up"}
						</Button>
					</div>
				</div>
			</SettingCard>
			<IntegrationSetupDialog
				integration={integration}
				open={setupOpen}
				onOpenChange={setSetupOpen}
				onSaved={onSaved}
			/>
		</>
	);
}

/** Every integration the registry knows about, as configuration cards. */
export function IntegrationsList({
	integrations,
	onSaved,
}: {
	integrations: SetupIntegration[];
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
}) {
	return (
		<>
			<div {...stylex.props(sx.grid, sx.gap3)}>
				{integrations.map((i) => (
					<IntegrationCard
						key={i.id}
						integration={i}
						onSaved={onSaved}
					/>
				))}
			</div>
			<SettingsHint>
				Credentials stay on this server and are never shown again. Changes apply after
				you restart.
			</SettingsHint>
		</>
	);
}

function GithubAuthSetupDialog({
	github,
	open,
	onOpenChange,
	configuration,
	error,
	dirty,
	saving,
	onSave,
}: {
	github: SetupGithub;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	configuration: React.ReactNode;
	error: string | null;
	dirty: boolean;
	saving: boolean;
	onSave: () => void;
}) {
	return (
		<Modal.Root open={open} onOpenChange={onOpenChange}>
			<Modal.Content widthClassName={mergeStylexClassName("", sharedClassStyles.maxW34rem)}>
				<Modal.Header
					title={
						<span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
							<IconTile name="github" size={28} />
							GitHub sign-in
						</span>
					}
					description="Let teammates connect GitHub so interactive sessions open PRs as them."
				/>
				<SettingsSection className={mergeStylexOverrideClassName("", sx.p4)}>{configuration}</SettingsSection>
				<Disclosure
					title="Setup guide"
					defaultOpen={!github.clientIdConfigured}
					actions={
						<LinkChips
							className={mergeStylexOverrideClassName("", sx.mt0)}
							links={[{ label: "Create GitHub App", url: github.appCreateUrl }]}
						/>
					}
				>
					<div {...stylex.props(sx.flex, sx.flexCol, sx.gap4)}>
						<SetupSteps steps={githubSetupSteps()} />
						<GuideBlock title="Permissions">
							<ul {...stylex.props(sx.m0, sx.flex, sx.flexCol, sx.gap15, sx.pl5, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
								<li>Contents write lets a connected teammate&rsquo;s interactive session push commits; pull-request and issue write cover PR creation, reviews, and conversation comments.</li>
								<li>A connected user can reach only repositories allowed by both their own GitHub access and the app installation.</li>
								<li>Personal tokens are injected only into interactive runs owned by that teammate. Automations continue to use the bot account.</li>
							</ul>
						</GuideBlock>
					</div>
				</Disclosure>
				{error && <InlineAlert>{error}</InlineAlert>}
				<Modal.Footer>
					<Modal.Close render={<Button variant="ghost" disabled={saving}>Cancel</Button>} />
					<Button variant="primary" disabled={!dirty || saving} onClick={onSave}>
						{saving ? "Saving…" : "Save"}
					</Button>
				</Modal.Footer>
			</Modal.Content>
		</Modal.Root>
	);
}

/** The GitHub App walkthrough as the dialog tells it: every step carries the
 *  reason it matters, because that is where someone is doing the work. */
function githubSetupSteps(): React.ReactNode[] {
	return [
		<>Create an organization-owned GitHub App.</>,
		<>
			Tick <strong>Enable Device Flow</strong>. Signing in is a device code, so without it nobody can sign in at all.
		</>,
		<>
			Under Repository permissions, grant <strong>Contents: read and write</strong>, <strong>Pull requests: read and write</strong>, and <strong>Issues: read and write</strong>. Under Organization permissions, grant <strong>Members: read-only</strong> so setup can import your team. Metadata remains read-only.
		</>,
		<>
			Install the app only on your organization. Choose all repositories, or select only the repositories Open Session should work in.
		</>,
		<>
			Paste the client id and the client secret above. Sign-in is a device code and needs no secret, but renewing a teammate&rsquo;s token does, and without it their access stops after a few hours.
		</>,
		<>
			Enable GitHub sign-in, save, restart Open Session, then have each teammate connect under Team → Account.
		</>,
	];
}

/** The same job at a glance, for onboarding. A first-run screen is read, not
 *  worked through, so each step is the action alone and the reasons wait for
 *  the setup dialog. */
const GITHUB_ONBOARDING_STEPS: React.ReactNode[] = [
	<>Create a GitHub App in your organization.</>,
	<>
		Choose any app name. The Homepage URL can be any URL, such as your company
		website.
	</>,
	<>
		Turn on <strong>Device Flow</strong>.
	</>,
	<>Grant Contents, Pull requests and Issues write, Members read.</>,
	<>Install it on your organization.</>,
	<>Paste the client id and secret below.</>,
	<>Save, then restart.</>,
];

export function GithubAuthCard({
	github,
	onSaved,
	onboarding = false,
}: {
	github: SetupGithub;
	onSaved: (updated: SetupGithub, restartRequired: boolean) => void;
	onboarding?: boolean;
}) {
	const state = githubAuthState(github);
	const active = github.userPrAuth && github.clientIdConfigured;
	// The secret is never echoed; the status exposes presence only.
	const secretConfigured = github.clientSecretConfigured;
	const [userPrAuth, setUserPrAuth] = useState(github.userPrAuth);
	const [botCredential, setBotCredential] = useState(github.botCredential);
	const [clientId, setClientId] = useState("");
	const [clientSecret, setClientSecret] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [clearId, setClearId] = useState(false);
	const [clearSecret, setClearSecret] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [setupOpen, setSetupOpen] = useState(false);

	useEffect(() => {
		setUserPrAuth(github.userPrAuth);
		setBotCredential(github.botCredential);
	}, [github.userPrAuth, github.botCredential]);

	const idCleared = github.clientIdConfigured && clearId && !clientId.trim();
	const secretCleared = secretConfigured && clearSecret && !clientSecret.trim();
	const dirty =
		userPrAuth !== github.userPrAuth ||
		botCredential !== github.botCredential ||
		clientId.trim() !== "" ||
		clientSecret.trim() !== "" ||
		privateKey.trim() !== "" ||
		idCleared ||
		secretCleared;

	async function handleSave() {
		if (!dirty || saving) return;
		setSaving(true);
		setError(null);
		await (async () => {
const body = await setupRequest<{
				github: SetupGithub;
				restartRequired: boolean;
			}>("/api/setup/github", {
				method: "PUT",
				json: {
					...(userPrAuth !== github.userPrAuth ? { userPrAuth } : {}),
					...(botCredential !== github.botCredential ? { botCredential } : {}),
					...(clientId.trim()
						? { oauthClientId: clientId.trim() }
						: idCleared
							? { oauthClientId: "" }
							: {}),
					...(clientSecret.trim()
						? { oauthClientSecret: clientSecret.replace(/\s+/g, "") }
						: secretCleared
							? { oauthClientSecret: "" }
							: {}),
					...(privateKey.trim() ? { privateKey: privateKey.trim() } : {}),
				},
			});
			setClientId("");
			setClientSecret("");
			setPrivateKey("");
			setClearId(false);
			setClearSecret(false);
			toast("GitHub sign-in settings saved");
			onSaved(body.github, body.restartRequired === true);
			setSetupOpen(false);
})().catch(async (e: any) => {
setError(e.message);
}).finally(async () => {
setSaving(false);
});
	}

	async function handleToggle(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		await (async () => {
const body = await setupRequest<{
				github: SetupGithub;
				restartRequired: boolean;
			}>("/api/setup/github", {
				method: "PUT",
				json: { userPrAuth: next },
			});
			setUserPrAuth(body.github.userPrAuth);
			toast(`GitHub sign-in ${next ? "enabled" : "disabled"}`);
			onSaved(body.github, body.restartRequired === true);
})().catch(async (cause) => {
toast(cause instanceof Error ? cause.message : "Could not update GitHub sign-in", {
				variant: "error",
			});
}).finally(async () => {
setSaving(false);
});
	}

	// One form, two homes: the settings dialog opens it on demand, while
	// onboarding puts it straight on the page. A first run has nothing to
	// protect behind a button, and the steps above end in these two fields.
	const configuration = (
		<>
			<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap4)}>
				<div {...stylex.props(sx.minW0, sx.flex1)}>
					<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>Enable GitHub sign-in</div>
					<div {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}>
						Takes effect after you restart Open Session.
					</div>
				</div>
				<Switch
					checked={userPrAuth}
					onCheckedChange={setUserPrAuth}
					disabled={saving}
					aria-label="Enable GitHub sign-in"
				/>
			</div>
			<div {...stylex.props(sx.mt4, sx.flex, sx.flexCol, sx.gap4, sx.borderT, sx.borderLine, sx.pt4)}>
				<div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap4)}>
					<div {...stylex.props(sx.minW0, sx.flex1)}>
						<div {...stylex.props(sx.fontMedium, sx.textFg, typography.itemTitle)}>Use the GitHub App for bot actions</div>
						<div {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}>
							Switches reviews, comments, clones and pushes away from the PAT.
						</div>
					</div>
					<Switch
						checked={botCredential === "app"}
						onCheckedChange={(checked) => setBotCredential(checked ? "app" : "pat")}
						disabled={saving || !github.appCredentialConfigured}
						aria-label="Use the GitHub App for bot actions"
					/>
				</div>
				{!github.appCredentialConfigured && (
					<p {...stylex.props(sx.m0, sx.textFaint, typography.supporting)}>
						Add the App private key before switching credentials.
					</p>
				)}
				<SecretField
					name="Client id"
					type="text"
					required
					placeholder="Iv23li…"
					present={github.clientIdConfigured}
					cleared={idCleared}
					value={clientId}
					disabled={saving}
					onChange={(value) => {
						setClientId(value);
						if (value.trim()) setClearId(false);
					}}
					onToggleClear={() => {
						setClearId((current) => !current);
						setClientId("");
					}}
				/>
				<SecretField
					name="Client secret"
					description="Renews teammates' tokens before they expire. Signing in works without it; staying signed in does not."
					present={secretConfigured}
					cleared={secretCleared}
					value={clientSecret}
					disabled={saving}
					onChange={(value) => {
						setClientSecret(value);
						if (value.trim()) setClearSecret(false);
					}}
					onToggleClear={() => {
						setClearSecret((current) => !current);
						setClientSecret("");
					}}
				/>
				<label {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
					<span {...stylex.props(sx.textFg, typography.supporting)}>Private key (PEM)</span>
					<textarea
						{...stylex.props(sx.minH20, sx.wFull, sx.resizeY, sx.roundedMd, sx.border, sx.borderLine, sx.bgSurface, sx.px25, sx.py15, sx.fontMono, sx.textFg, sx.outlineNone, sx.focusRing, typography.supporting)}
						value={privateKey}
						onChange={(e) => setPrivateKey(e.target.value)}
						placeholder="-----BEGIN RSA PRIVATE KEY-----"
						aria-label="GitHub App private key (PEM)"
						disabled={saving}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<span {...stylex.props(sx.leadingSnug, sx.textFaint, typography.meta)}>
						In the App&rsquo;s Private keys, Generate a private key and paste the
						.pem here. Lets the bot and PR checks run on the App; leave blank for
						sign-in only.
					</span>
				</label>
				<p {...stylex.props(sx.m0, sx.textFaint, typography.supporting)}>
					Credentials stay on this server and are never shown back.
				</p>
			</div>
		</>
	);

	return (
		<>
			<div {...mergeStylexProps("", sx.phonePx0, sx.grid, sx.px4)}>
				<SettingCard className={mergeStylexOverrideClassName("", onboarding && !active && sx.hidden)}>
					<div {...mergeStylexProps("", sx.gridColsAutoMinmax01frAuto, sx.phoneGridColsAutoMinmax01fr, sx.phonePx3, sx.phonePy2, sx.grid, sx.itemsStart, sx.gapX3, sx.gapY1, sx.px5, sx.py4)}>
						<IconTile name="github" size={40} />
						<div
							{...stylex.props(
								sx.headingRow,
								// Onboarding drops the description under this row, so the name
								// is alone beside a 40px tile and has to center against it.
								onboarding && sx.selfCenter,
							)}
						>
							<div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>
								{onboarding ? "GitHub" : "GitHub sign-in"}
							</div>
							<StateChip tone={state.tone} label={state.label} />
						</div>
						{!onboarding && (
							<div {...mergeStylexProps("", sx.phoneColSpan2, sx.phoneColStart1, sx.phoneMt3, sx.colStart2, sx.rowStart2, sx.minW0)}>
								<p {...stylex.props(sx.m0, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
									Interactive sessions open PRs as their connected owner instead of the bot.
								</p>
								{/* The Device Flow switch lives on GitHub, so nothing here can
								    report whether it is on. It is also the only way in now, so
								    the requirement is stated wherever the connection is set up
								    rather than left to the moment a teammate is locked out. */}
								{active && (
									<div {...stylex.props(sx.mt15, sx.leadingRelaxed, sx.textFaint, typography.meta)}>
										{"Device Flow must be enabled in your GitHub App." +
											(secretConfigured
												? ""
												: " Add a client secret to keep teammates signed in.")}
									</div>
								)}
							</div>
						)}
						{!onboarding && (
						<div {...mergeStylexProps("", sx.phoneColSpan2, sx.phoneColStart1, sx.phoneRowSpan1, sx.phoneRowStart3, sx.phoneMt4, sx.phoneMl0, sx.phoneFlexCol, sx.phoneItemsStretch, sx.colStart3, sx.rowSpan2, sx.rowStart1, sx.ml4, sx.flex, sx.minH10, sx.shrink0, sx.itemsCenter, sx.gap2)}>
							{(github.clientIdConfigured || github.userPrAuth) && (
								<>
									<div {...mergeStylexProps("", sx.phoneFlex, sx.hidden, sx.minH11, sx.itemsCenter, sx.justifyBetween, sx.fontMedium, sx.textDim, typography.label)}>
										<span>GitHub sign-in</span>
										<Switch
											checked={github.userPrAuth}
											onCheckedChange={(next) => void handleToggle(next)}
											disabled={saving || !github.clientIdConfigured}
											aria-label={`${github.userPrAuth ? "Disable" : "Enable"} GitHub sign-in`}
										/>
									</div>
									<div className={mergeStylexClassName("", sx.phoneHidden)}>
										<Switch
											checked={github.userPrAuth}
											onCheckedChange={(next) => void handleToggle(next)}
											disabled={saving || !github.clientIdConfigured}
											aria-label={`${github.userPrAuth ? "Disable" : "Enable"} GitHub sign-in`}
										/>
									</div>
								</>
							)}
							<Button
								size="sm"
								className={mergeStylexOverrideClassName("", sx.phoneMinH11, sx.phoneWFull, sx.phoneJustifyCenter)}
								variant={github.clientIdConfigured ? "default" : "primary"}
								onClick={() => setSetupOpen(true)}
							>
								{github.clientIdConfigured ? "Configure" : "Set up"}
							</Button>
						</div>
						)}
					</div>
				</SettingCard>
				{/* Onboarding shows the walkthrough up front: one GitHub App serves the
				    whole workspace, so the work is a one-time setup on GitHub that a
				    person should be able to read before opening a credentials form. */}
				{onboarding && (
					<div {...mergeStylexProps("", sx.phoneGridCols1, sx.mt3, sx.grid, sx.gridCols2, sx.itemsStart, sx.gap3)}>
						<SettingsSection className={mergeStylexOverrideClassName("", sx.flex, sx.hFull, sx.flexCol, sx.gap3)}>
							<div {...stylex.props(sx.fontSemibold, sx.textFg, typography.itemTitle)}>How to connect</div>
							<SetupSteps steps={GITHUB_ONBOARDING_STEPS} />
							<LinkChips
								className={mergeStylexOverrideClassName("", sx.mtAuto, sx.pt1)}
								links={[{ label: "Create GitHub App", url: github.appCreateUrl }]}
							/>
						</SettingsSection>
						<SettingsSection className={mergeStylexOverrideClassName("", sx.p4)}>
							{configuration}
							{error && <InlineAlert>{error}</InlineAlert>}
							<div {...stylex.props(sx.mt4, sx.flex, sx.justifyEnd)}>
								<Button
									variant="primary"
									className={mergeStylexOverrideClassName("", sx.phoneMinH11, sx.phoneWFull, sx.phoneJustifyCenter)}
									disabled={!dirty || saving}
									onClick={() => void handleSave()}
								>
									{saving ? "Saving…" : "Save"}
								</Button>
							</div>
						</SettingsSection>
					</div>
				)}
			</div>
			{!onboarding && (
				<GithubAuthSetupDialog
					github={github}
					open={setupOpen}
					onOpenChange={setSetupOpen}
					error={error}
					dirty={dirty}
					saving={saving}
					onSave={() => void handleSave()}
					configuration={configuration}
				/>
			)}
		</>
	);
}
