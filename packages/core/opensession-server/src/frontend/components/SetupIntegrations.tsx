import React, { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Disclosure } from "../ui/disclosure";
import { Modal } from "../ui/modal";
import { SettingCard, SettingsHint, SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Segmented, SegmentedOption } from "../ui/segmented";
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
	github: "PR comments, reviews, webhooks, and bot-authored work.",
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
				<div className="flex flex-wrap items-start gap-3 px-5 py-4">
					<IconTile name={integration.id} size={40} />
					<div className="min-w-[14rem] flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<div className="text-item-title font-semibold text-fg">{integration.label}</div>
							<StateChip tone={state.tone} label={state.label} />
						</div>
						<p className="m-0 mt-1 text-supporting leading-relaxed text-dim">
							{INTEGRATION_DESCRIPTIONS[integration.id] ?? `Connect ${integration.label} to Open Session.`}
						</p>
						{integration.missingRequired.length > 0 && (
							<div className="mt-2 text-meta text-yellow">
								Missing {integration.missingRequired.join(", ")}
							</div>
						)}
					</div>
					<div className="ml-auto flex min-h-10 shrink-0 items-center gap-2">
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
							className="max-sm:min-h-10"
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
			<div className="grid gap-3">
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
			<Modal.Content widthClassName="max-w-[34rem]">
				<Modal.Header
					title={
						<span className="flex items-center gap-2.5">
							<IconTile name="github" size={28} />
							GitHub sign-in
						</span>
					}
					description="Let teammates connect GitHub so interactive sessions open PRs as them."
				/>
				<SettingsSection className="p-4">{configuration}</SettingsSection>
				<Disclosure
					title="Setup guide"
					defaultOpen={!github.clientIdConfigured}
					actions={
						<LinkChips
							className="mt-0"
							links={[{ label: "Create GitHub App", url: github.appCreateUrl }]}
						/>
					}
				>
					<div className="flex flex-col gap-4">
						<SetupSteps steps={githubSetupSteps()} />
						<GuideBlock title="Permissions">
							<ul className="m-0 flex flex-col gap-1.5 pl-5 text-supporting leading-relaxed text-dim">
								<li>Contents write lets a connected teammate&rsquo;s interactive session push commits; pull-request and issue write cover PR creation, reviews, and conversation comments.</li>
								<li>A connected user can reach only repositories allowed by both their own GitHub access and the app installation.</li>
								<li>Teammate App tokens are injected only into interactive runs owned by that teammate. Automations continue to use the installation credential.</li>
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
			Under Repository permissions, grant <strong>Actions, Checks, Commit statuses, and Deployments: read-only</strong>; <strong>Contents, Pull requests, and Issues: read and write</strong>; and <strong>Metadata: read-only</strong>. Under Organization permissions, grant <strong>Members: read-only</strong>.
		</>,
		<>
			Install the app only on your organization. Choose all repositories, or select only the repositories Open Session should work in.
		</>,
		<>
			Paste the client id, app slug, installation owner, client secret, and private key above. The private key mints short-lived installation tokens for bot work; the client secret refreshes teammates&rsquo; device-flow tokens.
		</>,
		<>
			Choose GitHub authentication or None, save, then restart Open Session. With GitHub selected, each teammate connects under Team → Account.
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
	<>Grant the full permission set shown in the setup guide.</>,
	<>Install it on your organization.</>,
	<>Paste the client id, slug, owner, secret, and private key below.</>,
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
	const [clientId, setClientId] = useState("");
	const [appSlug, setAppSlug] = useState(github.appSlug ?? "");
	const [installationOwner, setInstallationOwner] = useState(
		github.installationOwner ?? github.appOrg ?? "",
	);
	const [clientSecret, setClientSecret] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [clearId, setClearId] = useState(false);
	const [clearSecret, setClearSecret] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [setupOpen, setSetupOpen] = useState(false);

	useEffect(() => {
		setUserPrAuth(github.userPrAuth);
		setAppSlug(github.appSlug ?? "");
		setInstallationOwner(github.installationOwner ?? github.appOrg ?? "");
	}, [
		github.userPrAuth,
		github.appSlug,
		github.installationOwner,
		github.appOrg,
	]);

	const idCleared = github.clientIdConfigured && clearId && !clientId.trim();
	const secretCleared = secretConfigured && clearSecret && !clientSecret.trim();
	const dirty =
		userPrAuth !== github.userPrAuth ||
		clientId.trim() !== "" ||
		appSlug.trim() !== (github.appSlug ?? "") ||
		installationOwner.trim() !==
			(github.installationOwner ?? github.appOrg ?? "") ||
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
					...(clientId.trim()
						? { oauthClientId: clientId.trim() }
						: idCleared
							? { oauthClientId: "" }
							: {}),
					...(appSlug.trim() !== (github.appSlug ?? "")
						? { appSlug: appSlug.trim() }
						: {}),
					...(installationOwner.trim() !==
						(github.installationOwner ?? github.appOrg ?? "")
						? { installationOwner: installationOwner.trim() }
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
			toast("GitHub App settings saved");
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
			<div className="flex flex-col gap-4">
				{onboarding && (
					<div className="flex items-center justify-between gap-4 phone:items-start">
						<div className="min-w-0 flex-1">
							<div className="text-item-title font-medium text-fg">Sign-in method</div>
							<div className="mt-0.5 text-supporting text-dim">
								Choose whether teammates sign in with GitHub.
							</div>
						</div>
						<Segmented
							label="Sign-in method"
							value={userPrAuth ? "github" : "none"}
							onValueChange={(value) => setUserPrAuth(value === "github")}
						>
							<SegmentedOption value="none">None</SegmentedOption>
							<SegmentedOption value="github">GitHub</SegmentedOption>
						</Segmented>
					</div>
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
				<label className="flex flex-col gap-1">
					<span className="text-supporting text-fg">App slug</span>
					<input
						type="text"
						className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring"
						value={appSlug}
						onChange={(event) => setAppSlug(event.target.value)}
						placeholder="open-session-example"
						aria-label="GitHub App slug"
						disabled={saving}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<span className="text-meta leading-snug text-faint">
						From github.com/apps/&lt;slug&gt;. Identifies App-authored comments
						and provides the installation link.
					</span>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-supporting text-fg">Installation owner</span>
					<input
						type="text"
						className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring"
						value={installationOwner}
						onChange={(event) => setInstallationOwner(event.target.value)}
						placeholder="my-organization"
						aria-label="GitHub App installation owner"
						disabled={saving}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<span className="text-meta leading-snug text-faint">
						The organization or account that owns the selected installation.
					</span>
				</label>
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
				<label className="flex flex-col gap-1">
					<span className="text-supporting text-fg">Private key (PEM)</span>
					<textarea
						className="min-h-20 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring"
						value={privateKey}
						onChange={(e) => setPrivateKey(e.target.value)}
						placeholder="-----BEGIN RSA PRIVATE KEY-----"
						aria-label="GitHub App private key (PEM)"
						disabled={saving}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<span className="text-meta leading-snug text-faint">
						In the App&rsquo;s Private keys, Generate a private key and paste the
						.pem here. Required for bot work and PR checks; leave blank only to keep the
						key already configured.
					</span>
				</label>
				<p className="m-0 text-supporting text-faint">
					Credentials stay on this server and are never shown back.
				</p>
			</div>
		</>
	);

	return (
		<>
			<div className="grid px-4 phone:px-0">
				<SettingCard className={onboarding && !active ? "hidden" : undefined}>
					<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-5 py-4 phone:grid-cols-[auto_minmax(0,1fr)] phone:px-3 phone:py-2">
						<IconTile name="github" size={40} />
						<div
							className={cn(
								"col-start-2 flex min-w-0 flex-wrap items-center gap-2",
								// Onboarding drops the description under this row, so the name
								// is alone beside a 40px tile and has to center against it.
								onboarding && "self-center",
							)}
						>
							<div className="text-item-title font-semibold text-fg">
								{onboarding ? "GitHub" : "Authentication"}
							</div>
							<StateChip tone={state.tone} label={state.label} />
						</div>
						{!onboarding && (
							<div className="col-start-2 row-start-2 min-w-0 phone:col-span-2 phone:col-start-1 phone:mt-3">
								<p className="m-0 text-supporting leading-relaxed text-dim">
									Choose None for an open workspace or GitHub to require teammate sign-in. The App always handles bot work.
								</p>
								{/* The Device Flow switch lives on GitHub, so nothing here can
								    report whether it is on. It is also the only way in now, so
								    the requirement is stated wherever the connection is set up
								    rather than left to the moment a teammate is locked out. */}
								{active && (
									<div className="mt-1.5 text-meta leading-relaxed text-faint">
										{"Device Flow must be enabled in your GitHub App." +
											(secretConfigured
												? ""
												: " Add a client secret to keep teammates signed in.")}
									</div>
								)}
							</div>
						)}
						{!onboarding && (
						<div className="col-start-3 row-span-2 row-start-1 ml-4 flex min-h-10 shrink-0 items-center gap-2 phone:col-span-2 phone:col-start-1 phone:row-span-1 phone:row-start-3 phone:mt-4 phone:ml-0 phone:flex-col phone:items-stretch">
							<Segmented
								label="Sign-in method"
								value={github.userPrAuth ? "github" : "none"}
								onValueChange={(value) => {
									if (value === "github" && !github.clientIdConfigured) {
										setUserPrAuth(true);
										setSetupOpen(true);
										return;
									}
									void handleToggle(value === "github");
								}}
								className="phone:w-full"
							>
								<SegmentedOption className="phone:flex-1 phone:justify-center" value="none">None</SegmentedOption>
								<SegmentedOption className="phone:flex-1 phone:justify-center" value="github">GitHub</SegmentedOption>
							</Segmented>
							<Button
								size="sm"
								className="phone:min-h-11 phone:w-full phone:justify-center"
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
					<div className="mt-3 grid grid-cols-2 items-start gap-3 phone:grid-cols-1">
						<SettingsSection className="flex h-full flex-col gap-3">
							<div className="text-item-title font-semibold text-fg">How to connect</div>
							<SetupSteps steps={GITHUB_ONBOARDING_STEPS} />
							<LinkChips
								className="mt-auto pt-1"
								links={[{ label: "Create GitHub App", url: github.appCreateUrl }]}
							/>
						</SettingsSection>
						<SettingsSection className="p-4">
							{configuration}
							{error && <InlineAlert>{error}</InlineAlert>}
							<div className="mt-4 flex justify-end">
								<Button
									variant="primary"
									className="phone:min-h-11 phone:w-full phone:justify-center"
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
