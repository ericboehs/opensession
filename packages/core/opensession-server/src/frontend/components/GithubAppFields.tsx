import { Badge } from "../ui/badge";
import { SecretField, type SetupGithub } from "./setup-shared";

export function GithubAppFields({
	github,
	saving,
	clientId,
	appSlug,
	installationOwner,
	clientSecret,
	privateKey,
	clientIdCleared,
	clientSecretCleared,
	onClientIdChange,
	onToggleClientIdClear,
	onAppSlugChange,
	onInstallationOwnerChange,
	showInstallationOwner = true,
	onClientSecretChange,
	onToggleClientSecretClear,
	onPrivateKeyChange,
}: {
	github: SetupGithub;
	saving: boolean;
	clientId: string;
	appSlug: string;
	installationOwner: string;
	clientSecret: string;
	privateKey: string;
	clientIdCleared: boolean;
	clientSecretCleared: boolean;
	onClientIdChange: (value: string) => void;
	onToggleClientIdClear: () => void;
	onAppSlugChange: (value: string) => void;
	onInstallationOwnerChange: (value: string) => void;
	showInstallationOwner?: boolean;
	onClientSecretChange: (value: string) => void;
	onToggleClientSecretClear: () => void;
	onPrivateKeyChange: (value: string) => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<SecretField
				name="Client id"
				type="text"
				required
				placeholder="Iv23li…"
				present={github.clientIdConfigured}
				cleared={clientIdCleared}
				value={clientId}
				disabled={saving}
				onChange={onClientIdChange}
				onToggleClear={onToggleClientIdClear}
			/>
			<label className="flex flex-col gap-1">
				<span className="text-supporting text-fg">App slug</span>
				<input
					type="text"
					className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring phone:min-h-11 phone:text-input-phone"
					value={appSlug}
					onChange={(event) => onAppSlugChange(event.target.value)}
					placeholder="open-session-example"
					aria-label="GitHub App slug"
					disabled={saving}
					autoCapitalize="none"
					autoComplete="off"
					spellCheck={false}
				/>
				<span className="text-meta leading-snug text-faint">
					From github.com/apps/&lt;slug&gt;. Identifies App-authored activity.
				</span>
			</label>
			{showInstallationOwner && (
				<label className="flex flex-col gap-1">
					<span className="text-supporting text-fg">Installation owner</span>
					<input
						type="text"
						className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring phone:min-h-11 phone:text-input-phone"
						value={installationOwner}
						onChange={(event) => onInstallationOwnerChange(event.target.value)}
						placeholder="my-organization"
						aria-label="GitHub App installation owner"
						disabled={saving}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
					/>
					<span className="text-meta leading-snug text-faint">
						Required. Enter the GitHub login for the account or organization where the App is installed. Open Session uses it to select the installation that mints repository tokens.
					</span>
				</label>
			)}
			<SecretField
				name="Client secret"
				required
				present={github.clientSecretConfigured}
				cleared={clientSecretCleared}
				value={clientSecret}
				disabled={saving}
				onChange={onClientSecretChange}
				onToggleClear={onToggleClientSecretClear}
			/>
			<label className="flex flex-col gap-1">
				<span className="flex items-center justify-between gap-2">
					<span className="text-label font-medium text-dim">Private key (PEM)</span>
					{github.privateKeyConfigured ? (
						<span className="shrink-0 text-meta text-green">Saved</span>
					) : (
						<Badge tone="warning">Required</Badge>
					)}
				</span>
				<textarea
					className="min-h-20 w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-supporting text-fg outline-none focus-ring phone:text-input-phone"
					value={privateKey}
					onChange={(event) => onPrivateKeyChange(event.target.value)}
					placeholder={
						github.privateKeyConfigured
							? "Leave blank to keep"
							: "-----BEGIN RSA PRIVATE KEY-----"
					}
					aria-label="GitHub App private key (PEM)"
					required
					disabled={saving}
					autoCapitalize="none"
					autoComplete="off"
					spellCheck={false}
				/>
				<span className="text-meta leading-snug text-faint">
					Paste a generated private key, or leave blank to keep the current key.
				</span>
			</label>
		</div>
	);
}
