import React, { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Disclosure } from "../ui/disclosure";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { SettingCard, SettingsHint, SettingsSection } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import {
	githubAppCreateOwner,
	githubAppCreateUrlForOwner,
	githubAppInstallUrlForSlug,
	shouldReloadAfterGithubAuthEnabled,
	type GithubAppOwnerType,
} from "../lib/github-app-setup";
import {
	GuideBlock,
	LinkChips,
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
import { GithubAppFields } from "./GithubAppFields";

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
	github,
	onGithubSaved,
}: {
	integration: SetupIntegration;
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
	github?: SetupGithub;
	onGithubSaved?: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
	const state = integrationState(integration);
	const [setupOpen, setSetupOpen] = useState(false);
	const [toggling, setToggling] = useState(false);
	const hasCredentials =
		integration.env.some((envVar) => envVar.present) ||
		(integration.id === "github" && Boolean(github?.appCredentialConfigured));
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
						{integration.enabled && integration.missingRequired.length > 0 && (
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
				github={integration.id === "github" ? github : undefined}
				onGithubSaved={onGithubSaved}
			/>
		</>
	);
}

/** Every integration the registry knows about, as configuration cards. */
export function IntegrationsList({
	integrations,
	onSaved,
	github,
	onGithubSaved,
}: {
	integrations: SetupIntegration[];
	onSaved: (updated: SetupIntegration, restartRequired: boolean) => void;
	github?: SetupGithub;
	onGithubSaved?: (updated: SetupGithub, restartRequired: boolean) => void;
}) {
	return (
		<>
			<div className="grid gap-3">
				{integrations.map((i) => (
					<IntegrationCard
						key={i.id}
						integration={i}
						onSaved={onSaved}
						github={github}
						onGithubSaved={onGithubSaved}
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
function githubOnboardingSteps(owner: GithubAppOwnerType): React.ReactNode[] {
	const account = owner === "organization" ? "organization" : "personal account";
	return [
		<>Create a GitHub App for your {account}.</>,
		<>
			Open the prefilled form. The Homepage and webhook URLs are already filled in;
			change the app name if you want.
		</>,
		<>
			Confirm <strong>Device Flow</strong> is on.
		</>,
		<>Grant the full permission set shown in the setup guide.</>,
		<>
			After GitHub creates the App, choose <strong>Install App</strong> in its sidebar
			and install it on the {account} entered above.
		</>,
		<>Paste the client id, slug, secret, and private key. The installation owner is already filled in.</>,
		<>Save, then restart.</>,
	];
}

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
	const initialCreateOwner = githubAppCreateOwner(github.appCreateUrl);
	const [appOwner, setAppOwner] = useState<GithubAppOwnerType>(
		github.appOrg ? "organization" : initialCreateOwner.type,
	);
	const [ownerDrafts, setOwnerDrafts] = useState<Record<GithubAppOwnerType, string>>({
		personal: initialCreateOwner.type === "personal" ? github.installationOwner ?? "" : "",
		organization:
			github.appOrg ??
			(initialCreateOwner.type === "organization"
				? github.installationOwner ?? initialCreateOwner.login
				: ""),
	});
	const installationOwner = ownerDrafts[appOwner];
	const setInstallationOwner = (value: string) => {
		setOwnerDrafts((current) => ({ ...current, [appOwner]: value }));
	};
	const [clientSecret, setClientSecret] = useState("");
	const [mentionHandle, setMentionHandle] = useState(github.mentionHandle);
	const [privateKey, setPrivateKey] = useState("");
	const [clearId, setClearId] = useState(false);
	const [clearSecret, setClearSecret] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [setupOpen, setSetupOpen] = useState(false);

	useEffect(() => {
		setUserPrAuth(github.userPrAuth);
		setAppSlug(github.appSlug ?? "");
		setMentionHandle(github.mentionHandle);
	}, [
		github.userPrAuth,
		github.appSlug,
		github.mentionHandle,
	]);

	const normalizedMentionHandle = mentionHandle.trim().replace(/^@/, "");
	const appCreateUrl = githubAppCreateUrlForOwner(
		github.appCreateUrl,
		appOwner,
		installationOwner,
	);
	const appInstallUrl = githubAppInstallUrlForSlug(appSlug || github.appSlug);
	const installationOwnerReady = !!installationOwner.trim();
	const idCleared = github.clientIdConfigured && clearId && !clientId.trim();
	const secretCleared = secretConfigured && clearSecret && !clientSecret.trim();
	const dirty =
		userPrAuth !== github.userPrAuth ||
		clientId.trim() !== "" ||
		appSlug.trim() !== (github.appSlug ?? "") ||
		installationOwner.trim() !==
			(github.installationOwner ?? github.appOrg ?? "") ||
		clientSecret.trim() !== "" ||
		normalizedMentionHandle !== github.mentionHandle ||
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
					...(normalizedMentionHandle !== github.mentionHandle
						? { mentionHandle: normalizedMentionHandle }
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
			if (shouldReloadAfterGithubAuthEnabled(github.userPrAuth, body.github.userPrAuth, onboarding)) {
				window.location.reload();
			}
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
			if (shouldReloadAfterGithubAuthEnabled(github.userPrAuth, body.github.userPrAuth, onboarding)) {
				window.location.reload();
			}
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
							<div className="text-dialog-title font-medium text-fg">Sign-in method</div>
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
				<GithubAppFields
					github={github}
					saving={saving}
					clientId={clientId}
					appSlug={appSlug}
					installationOwner={installationOwner}
					clientSecret={clientSecret}
					privateKey={privateKey}
					clientIdCleared={idCleared}
					clientSecretCleared={secretCleared}
					onClientIdChange={(value) => {
						setClientId(value);
						if (value.trim()) setClearId(false);
					}}
					onToggleClientIdClear={() => {
						setClearId((current) => !current);
						setClientId("");
					}}
					onAppSlugChange={setAppSlug}
					onInstallationOwnerChange={setInstallationOwner}
					showInstallationOwner={!onboarding}
					onClientSecretChange={(value) => {
						setClientSecret(value);
						if (value.trim()) setClearSecret(false);
					}}
					onToggleClientSecretClear={() => {
						setClearSecret((current) => !current);
						setClientSecret("");
					}}
					onPrivateKeyChange={setPrivateKey}
				/>
				<label className="flex flex-col gap-1">
					<span className="text-label font-medium text-dim">Mention handle</span>
					<span className="text-supporting text-faint">
						PR comments that mention this handle start a session.
					</span>
					<div className="mt-0.5 flex h-8 w-full items-center rounded-control border border-line bg-surface transition-colors focus-within:border-accent phone:h-11">
						<span className="pl-2.5 text-sm text-faint" aria-hidden="true">@</span>
						<input
							type="text"
							className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-1.5 pr-2.5 text-sm text-fg outline-none placeholder:text-faint phone:text-input-phone"
							value={mentionHandle}
							onChange={(event) => setMentionHandle(event.target.value)}
							placeholder="opensession"
							aria-label="GitHub mention handle"
							disabled={saving}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>
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
							<div
								className={cn(
									"font-semibold text-fg",
									onboarding ? "text-dialog-title" : "text-item-title",
								)}
							>
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
						<SettingsSection className="flex flex-col gap-4">
							<div className="text-dialog-title font-semibold text-fg">How to connect</div>
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between gap-3 phone:flex-col phone:items-stretch">
									<div>
										<div className="text-label font-medium text-dim">Create for</div>
										<div className="mt-0.5 text-supporting text-faint">Choose who owns and installs the GitHub App.</div>
									</div>
									<Segmented
										label="GitHub App owner"
										value={appOwner}
										onValueChange={(value) => setAppOwner(value as GithubAppOwnerType)}
										className="phone:w-full"
									>
										<SegmentedOption value="personal" className="phone:min-h-11 phone:flex-1 phone:justify-center">Personal account</SegmentedOption>
										<SegmentedOption value="organization" className="phone:min-h-11 phone:flex-1 phone:justify-center">Organization</SegmentedOption>
									</Segmented>
								</div>
								<label className="flex flex-col gap-1">
									<span className="text-label font-medium text-dim">
										{appOwner === "organization" ? "Organization login" : "GitHub username"}
									</span>
									<Input
										value={installationOwner}
										onChange={(event) => setInstallationOwner(event.target.value)}
										placeholder={appOwner === "organization" ? "my-organization" : "octocat"}
										className="font-mono phone:min-h-11 phone:text-input-phone"
										disabled={saving}
										autoCapitalize="none"
										autoComplete="off"
										spellCheck={false}
									/>
									<span className="text-meta leading-snug text-faint">
										Required. This is where you install the App. Open Session uses it to select the installation that mints repository tokens.
									</span>
								</label>
							</div>
							<SetupSteps steps={githubOnboardingSteps(appOwner)} />
							<div className="mt-auto flex flex-col gap-2">
								{installationOwnerReady ? (
									<Button
										variant="primary"
										size="lg"
										className="min-h-11 w-full justify-center"
										render={<a href={appCreateUrl} target="_blank" rel="noreferrer" />}
									>
										Create GitHub App
									</Button>
								) : (
									<Button variant="primary" size="lg" className="min-h-11 w-full justify-center" disabled>
										Create GitHub App
									</Button>
								)}
								{appInstallUrl && (
									<Button
										size="lg"
										className="min-h-11 w-full justify-center"
										render={<a href={appInstallUrl} target="_blank" rel="noreferrer" />}
									>
										Install GitHub App
									</Button>
								)}
							</div>
						</SettingsSection>
						<SettingsSection className="p-4">
							{configuration}
							{error && <InlineAlert>{error}</InlineAlert>}
							<div className="mt-4 flex justify-end">
								<Button
									variant="primary"
									className="phone:min-h-11 phone:w-full phone:justify-center"
									disabled={!dirty || saving || !installationOwnerReady}
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
