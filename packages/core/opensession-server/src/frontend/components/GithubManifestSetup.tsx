import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { BASE_PATH } from "../lib/base";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { SettingsHint } from "../ui/settings";
import { duration } from "../ui/motion";
import { InlineAlert } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { IconTile } from "./BrandTile";
import { IconCheckCircleFilled, IconQuestionCircle } from "./icons";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "calc(4px * 4)"
	},
	minW0: {
			minWidth: "0"
	},
	mt6: {
			marginTop: "calc(4px * 6)"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFg: {
			color: "var(--text)"
	},
	pt1: {
			paddingTop: "4px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap2: {
			gap: "calc(4px * 2)"
	},
	wFull: {
			width: "100%"
	},
	flex1: {
			flex: "1"
	},
	textCenter: {
			textAlign: "center"
	},
	gap1: {
			gap: "4px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
});

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
		<div className={utilityClassName("relative")}>
			<Button
				size="lg"
				icon={
					<IconCheckCircleFilled
						size={20}
						className={complete ? utilityClassName("text-green") : utilityClassName("text-faint")}
					/>
				}
				className={cn(
					utilityClassName("min-h-11 w-full justify-start pr-12"),
					complete && utilityClassName("disabled:opacity-100"),
				)}
				disabled={disabled || (!href && !onClick)}
				onClick={onClick}
				{...(href
					? { render: <a href={href} target="_blank" rel="noreferrer" /> }
					: {})}
			>
				{label}
			</Button>
			<Tooltip
				side="top"
				align="end"
				offset={6}
				label={
					<span
						aria-label={`${label} screenshot placeholder`}
						className={utilityClassName("flex h-20 w-[100px] flex-col justify-end gap-1.5 rounded-md bg-white/10 p-2")}
					>
						<span className={utilityClassName("h-2 w-12 rounded-sm bg-white/20")} />
						<span className={utilityClassName("h-1.5 w-16 rounded-sm bg-white/15")} />
					</span>
				}
			>
				<button
					type="button"
					aria-label={`Preview ${label.toLowerCase()}`}
					className={utilityClassName("focus-ring absolute top-1/2 right-1 z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-control text-faint transition-colors duration-[var(--dur-micro)] hover:bg-hover hover:text-fg phone:right-0 phone:size-11")}
				>
					<IconQuestionCircle size={20} />
				</button>
			</Tooltip>
		</div>
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
				<>
					<div className={utilityClassName("flex items-center gap-2")}>
						<IconTile name="github" size={40} />
						<span
							aria-hidden="true"
							className={utilityClassName("w-6 border-t-2 border-dotted border-line-strong")}
						/>
						<img
							src={`${BASE_PATH}/mac-app-icon.png`}
							alt=""
							className={utilityClassName("size-10 shrink-0")}
						/>
					</div>
					<div className={utilityClassName("flex items-center justify-between gap-4")}>
						<div className={utilityClassName("min-w-0 text-dialog-title font-semibold text-fg")}>
							Install Open Session for GitHub
						</div>
						<StateChip tone={connectionStatus.tone} label={connectionStatus.label} />
					</div>
				</>
			) : (
				<div className={utilityClassName("text-dialog-title font-semibold text-fg")}>
					Install Open Session for GitHub
				</div>
			)}
			<div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
				<Segmented
					label="GitHub App owner"
					value={owner}
					onValueChange={(value) => setOwner(value as GithubAppOwnerType)}
					className={mergeStylexOverrideClassName("", sx.wFull)}
				>
					<SegmentedOption
						value="personal"
						className={mergeStylexOverrideClassName("phone:min-h-11 [&>span:last-child]:justify-center", sx.flex1, sx.textCenter)}
					>
						Personal account
					</SegmentedOption>
					<SegmentedOption
						value="organization"
						className={mergeStylexOverrideClassName("phone:min-h-11 [&>span:last-child]:justify-center", sx.flex1, sx.textCenter)}
					>
						Organization
					</SegmentedOption>
				</Segmented>
				{formOwner === "organization" && (
					<label {...stylex.props(sx.flex, sx.flexCol, sx.gap1)}>
						<span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>Organization ID</span>
						<Input
							value={formInstallationOwner}
							onChange={(event) =>
								setOwnerDrafts((current) => ({
									...current,
									organization: event.target.value,
								}))
							}
							placeholder="my-organization"
							className={mergeStylexOverrideClassName("phone:min-h-11 phone:text-input-phone", sx.fontMono)}
							disabled={starting}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
				)}
			</div>
			<div {...stylex.props(sx.flex, sx.flexCol, sx.gap2)}>
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
				<SettingsHint className={utilityClassName("m-0")}>
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
