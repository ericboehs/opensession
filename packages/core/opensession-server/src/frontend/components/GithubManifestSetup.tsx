import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingsHint } from "../ui/settings";
import { duration } from "../ui/motion";
import { InlineAlert } from "../ui/state";
import { IconTile } from "./BrandTile";
import { IconCheckCircle } from "./icons";
import {
	githubAppCreateOwner,
	githubAppInstallUrlForSlug,
	githubAppSettingsUrlForSlug,
	githubAppSetupOwner,
	githubManifestAction,
	type GithubAppOwnerType,
} from "../lib/github-app-setup";
import {
	StateChip,
	setupRequest,
	type ChipTone,
	type SetupGithub,
} from "./setup-shared";

function GithubSetupStep({
	label,
	complete = false,
	href,
	disabled,
	onClick,
}: {
	label: string;
	complete?: boolean;
	href?: string | null;
	disabled?: boolean;
	onClick?: () => void;
}) {
	return (
		<Button
			size="lg"
			icon={
				<IconCheckCircle
					size={20}
					className={complete ? "text-green" : "text-faint"}
				/>
			}
			className={cn(
				"min-h-11 w-full justify-start",
				complete && "disabled:opacity-100",
			)}
			disabled={disabled || (!href && !onClick)}
			onClick={onClick}
			{...(href
				? { render: <a href={href} target="_blank" rel="noreferrer" /> }
				: {})}
		>
			{label}
		</Button>
	);
}

export function GithubManifestSetup({
	github,
	returnTo,
	connectionStatus,
}: {
	github: SetupGithub;
	returnTo: "welcome" | "settings";
	connectionStatus?: { tone: ChipTone; label: string };
}) {
	const initialOwner = githubAppCreateOwner(github.appCreateUrl);
	const [owner, setOwner] = useState<GithubAppOwnerType>(
		githubAppSetupOwner(github),
	);
	// Keep the owner-specific form in place while the segmented knob travels.
	// Once the click has visibly settled, the form can change the modal height
	// without competing with that direct feedback.
	const [formOwner, setFormOwner] = useState(owner);
	const reducedMotion = useReducedMotion();
	const [ownerDrafts, setOwnerDrafts] = useState<Record<GithubAppOwnerType, string>>({
		personal: initialOwner.type === "personal" ? github.installationOwner ?? "" : "",
		organization:
			github.appOrg ??
			(initialOwner.type === "organization"
				? github.installationOwner ?? initialOwner.login
				: ""),
	});
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const installationOwner = ownerDrafts[owner];
	const formInstallationOwner = ownerDrafts[formOwner];
	const ownerSwitching = owner !== formOwner;
	const ownerReady = owner === "personal" || Boolean(installationOwner.trim());

	useEffect(() => {
		if (!ownerSwitching) return;
		const reveal = window.setTimeout(
			() => setFormOwner(owner),
			(reducedMotion ? 0 : duration.base) * 1000,
		);
		return () => window.clearTimeout(reveal);
	}, [owner, ownerSwitching, reducedMotion]);
	const settingsUrl = githubAppSettingsUrlForSlug(
		github.appSlug,
		github.appOrg,
	);
	const installUrl = githubAppInstallUrlForSlug(github.appSlug ?? "");
	const result =
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get("github_manifest");

	async function createApp() {
		if (starting || !ownerReady) return;
		setStarting(true);
		setError(null);
		try {
			const body = await setupRequest<{ action: string; manifest: string }>(
				"/api/setup/github/manifest",
				{
					method: "POST",
					json: {
						owner,
						returnTo,
						...(owner === "organization"
							? { organization: installationOwner.trim() }
							: {}),
					},
				},
			);
			const action = githubManifestAction(body.action);
			if (!action) {
				setError("GitHub returned an invalid App registration address");
				setStarting(false);
				return;
			}
			const form = document.createElement("form");
			form.method = "post";
			form.action = action;
			form.hidden = true;
			const manifest = document.createElement("input");
			manifest.type = "hidden";
			manifest.name = "manifest";
			manifest.value = body.manifest;
			form.append(manifest);
			document.body.append(form);
			if (returnTo === "welcome") {
				window.sessionStorage.setItem("opensession:first-mile-step", "github");
			}
			form.submit();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not start GitHub App setup",
			);
			setStarting(false);
		}
	}

	return (
		<>
			{connectionStatus ? (
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<IconTile name="github" size={40} />
						<div className="mt-6 text-dialog-title font-semibold text-fg">
							How to connect
						</div>
					</div>
					<div className="pt-1">
						<StateChip tone={connectionStatus.tone} label={connectionStatus.label} />
					</div>
				</div>
			) : (
				<div className="text-dialog-title font-semibold text-fg">How to connect</div>
			)}
			<div className="flex flex-col gap-2">
				<Segmented
					label="GitHub App owner"
					value={owner}
					onValueChange={(value) => setOwner(value as GithubAppOwnerType)}
					className="w-full"
				>
					<SegmentedOption
						value="personal"
						className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
					>
						Personal account
					</SegmentedOption>
					<SegmentedOption
						value="organization"
						className="flex-1 text-center phone:min-h-11 [&>span:last-child]:justify-center"
					>
						Organization
					</SegmentedOption>
				</Segmented>
				{formOwner === "organization" && (
					<label className="flex flex-col gap-1">
						<span className="text-label font-medium text-dim">Organization ID</span>
						<Input
							value={formInstallationOwner}
							onChange={(event) =>
								setOwnerDrafts((current) => ({
									...current,
									organization: event.target.value,
								}))
							}
							placeholder="my-organization"
							className="font-mono phone:min-h-11 phone:text-input-phone"
							disabled={starting}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
						/>
						<span data-onboarding-caption="" className="text-meta text-faint">
							The organization that will own and install the App.
						</span>
					</label>
				)}
			</div>
			<div className="flex flex-col gap-2">
				<GithubSetupStep
					label="Create GitHub app"
					complete={github.clientIdConfigured}
					disabled={
						github.clientIdConfigured || !ownerReady || ownerSwitching || starting
					}
					onClick={() => void createApp()}
				/>
				<GithubSetupStep label="Enable Device Flow" href={settingsUrl} />
				<GithubSetupStep label="Install GitHub app" href={installUrl} />
			</div>
			{result === "created" && (
				<SettingsHint className="m-0">
					GitHub App created. Enable Device Flow before you install it.
				</SettingsHint>
			)}
			{result === "error" && (
				<InlineAlert>GitHub App setup could not be completed. Try again.</InlineAlert>
			)}
			{error && <InlineAlert>{error}</InlineAlert>}
		</>
	);
}
