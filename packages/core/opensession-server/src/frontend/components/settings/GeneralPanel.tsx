import React, { useEffect, useState } from "react";
import {
	fetchGithubOrganizationProfile,
	fetchOrganizationSettings,
	removeOrganizationIcon,
	saveOrganizationSettings,
	uploadOrganizationIcon,
	type OrganizationSettingsDto,
} from "../../lib/api";
import { rememberOrganizationIcon } from "../../hooks/useOrganizationIcon";
import { PRODUCT_NAME } from "../../lib/brand";
import { pngFromImageFile, pngFromImageUrl } from "../../lib/icon-image";
import { REPO_TILE_INK, repoColor, repoIconFill } from "../../lib/repo-colors";
import { cn } from "../../ui/cn";
import { OverlayAction } from "../../ui/overlay-action";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingRow,
	SettingRowControl,
	SettingRowText,
	SettingRowTitle,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	settingsInputClass,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { InlineAlert } from "../../ui/state";
import { IconArrowUpToLine, IconTrash } from "../icons";
import { IdentityRows } from "../SetupIdentity";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	itemsCenter: {
			alignItems: "center"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
	gap2: {
			gap: "8px"
	},
	relative: {
			position: "relative"
	},
	shrink0: {
			flexShrink: "0"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap15: {
			gap: "6px"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	size14: {
			width: "56px",
			height: "56px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	outlineDivider: {
			outlineColor: "var(--divider)"
	},
	sizeFull: {
			width: "100%",
			height: "100%"
	},
	objectCover: {
			objectFit: "cover"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	inset0: {
			inset: "0"
	},
	grid: {
			display: "grid"
	},
	placeItemsCenter: {
			placeItems: "center"
	},
	roundedInherit: {
			borderRadius: "inherit"
	},
	bgBlack50: {
			backgroundColor: "#00000080"
	},
	textWhite: {
			color: "var(--color-white)"
	},
	opacity0: {
			opacity: "0"
	},
	transitionOpacity: {
			transitionProperty: "opacity",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	duration150: {
			transitionDuration: ".15s"
	},
	textRed: {
			color: "var(--red)"
	},
	hidden: {
			display: "none"
	},
});

const NAME_INPUT_CLASS = cn(settingsInputClass, "w-[220px] max-w-full");

/**
 * The organization's name, mark and email domain.
 *
 * In onboarding this step runs directly after GitHub, and `githubOrganization`
 * is the org that was just connected. Rather than ask for three things the
 * connection already knows, the first render of a fresh instance fills them in
 * from GitHub — the org's display name, its avatar, and the domain off its
 * profile — and leaves every field editable. It only ever fills a field nobody
 * has set, so re-opening onboarding cannot overwrite a rename.
 */
export function OrganizationProfileSection({
	githubOrganization,
	showDomain = true,
}: {
	githubOrganization?: string;
	showDomain?: boolean;
} = {}) {
	const [settings, setSettings] = useState<OrganizationSettingsDto | null>(null);
	const [draft, setDraft] = useState("");
	const [domainDraft, setDomainDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [iconFailed, setIconFailed] = useState(false);
	const fileInput = React.useRef<HTMLInputElement>(null);
	// One attempt per mount: a failed lookup must not retry on every render, and
	// a successful one must not fight the operator's own edits.
	const prefilled = React.useRef(false);

	async function load(cancelled?: () => boolean) {
		setLoadError(null);
		await (async () => {
const next = await fetchOrganizationSettings();
			if (cancelled?.()) return;
			setSettings(next);
			setDraft(next.organizationName);
			setDomainDraft(next.organizationDomain);
			rememberOrganizationIcon(next);
})().catch(async (error: any) => {
if (cancelled?.()) return;
			const message = error?.message || "Couldn’t load organization settings";
			setLoadError(message);
			toast(message, { variant: "error" });
});
	}

	useEffect(() => {
		let cancelled = false;
		void load(() => cancelled);
		return () => {
			cancelled = true;
		};
	}, []);

	async function update(work: () => Promise<OrganizationSettingsDto>, message: string) {
		if (busy) return;
		setBusy(true);
		await (async () => {
const next = await work();
			setSettings(next);
			setDraft(next.organizationName);
			setDomainDraft(next.organizationDomain);
			setIconFailed(false);
			rememberOrganizationIcon(next);
			toast(message, { variant: "success" });
})().catch(async (error: any) => {
toast(error?.message || "Couldn’t save organization settings", {
				variant: "error",
			});
			if (settings) {
				setDraft(settings.organizationName);
				setDomainDraft(settings.organizationDomain);
			}
}).finally(async () => {
setBusy(false);
});
	}

	async function commitName() {
		const next = draft.trim();
		if (!settings || next === settings.organizationName || busy) {
			if (settings) setDraft(settings.organizationName);
			return;
		}
		await update(
			() => saveOrganizationSettings({ organizationName: next }),
			"Organization name saved.",
		);
	}

	// Fill only what is still unset. A fresh install has no icon, no domain, and
	// a name that is still the product's own.
	useEffect(() => {
		const login = githubOrganization?.trim();
		if (!login || !settings || prefilled.current || busy) return;
		const needsName =
			!settings.organizationName || settings.organizationName === PRODUCT_NAME;
		const needsIcon = !settings.organizationIconUrl;
		const needsDomain = !settings.organizationDomain;
		if (!needsName && !needsIcon && !needsDomain) return;
		prefilled.current = true;
		void (async () => {
			const profile = await fetchGithubOrganizationProfile(login);
			await update(async () => {
				if (needsIcon && profile?.avatarUrl) {
					const icon = await pngFromImageUrl(profile.avatarUrl);
					if (icon) await uploadOrganizationIcon(icon);
				}
				return saveOrganizationSettings({
					...(needsName ? { organizationName: profile?.name || login } : {}),
					...(needsDomain && profile?.domain
						? { organizationDomain: profile.domain }
						: {}),
				});
			}, `Filled in from ${login} on GitHub.`);
		})();
	}, [githubOrganization, settings, busy]);

	async function commitDomain() {
		const next = domainDraft.trim();
		if (!settings || next === settings.organizationDomain || busy) {
			if (settings) setDomainDraft(settings.organizationDomain);
			return;
		}
		await update(
			() => saveOrganizationSettings({ organizationDomain: next }),
			next ? "Organization domain saved." : "Organization domain cleared.",
		);
	}

	async function upload(file: File) {
		await update(async () => {
			const png = await pngFromImageFile(file);
			return uploadOrganizationIcon(png);
		}, "Organization icon updated.");
	}

	function removeIcon() {
		void update(removeOrganizationIcon, "Organization icon removed.");
	}

	const nameParts = (settings?.organizationName || "Organization").trim().split(/\s+/);
	const initials = (
		nameParts.length > 1
			? `${nameParts[0].charAt(0)}${nameParts.at(-1)?.charAt(0) || ""}`
			: nameParts[0].slice(0, 2)
	).toUpperCase();
	const showIcon = !!settings?.organizationIconUrl && !iconFailed;
	const fallbackColor = repoColor(settings?.organizationName || "organization");

	return (
		<>
			{loadError && !settings ? (
				<InlineAlert onRetry={() => void load()}>{loadError}</InlineAlert>
			) : settings ? (
				<>
					<SettingCard>
						<SettingRow {...stylex.props(sx.itemsCenter)}>
							<SettingRowText>
								<SettingRowTitle>Upload icon</SettingRowTitle>
							</SettingRowText>
							<SettingRowControl {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.justifyEnd, sx.gap2)}>
								<div className="group/overlay-action" {...stylex.props(sx.relative, sx.flex, sx.shrink0, sx.flexCol, sx.itemsCenter, sx.gap15)}>
									<button
										type="button"
										disabled={busy}
										onClick={() => fileInput.current?.click()}
										aria-label={showIcon ? "Change organization icon" : "Upload organization icon"}
										className="group/upload outline outline-1 disabled:pointer-events-none" {...stylex.props(sx.focusRing, sx.relative, sx.flex, sx.size14, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.overflowHidden, sx.roundedLg, sx.fontSemibold, sx.outlineDivider, typography.sectionTitle)}
										style={
											showIcon
												? undefined
												: {
														backgroundImage: repoIconFill(fallbackColor),
														color: REPO_TILE_INK,
													}
										}
									>
										{showIcon ? (
											<img
												src={settings.organizationIconUrl || undefined}
												alt=""
												{...stylex.props(sx.sizeFull, sx.objectCover)}
												onError={() => setIconFailed(true)}
											/>
										) : (
											initials
										)}
										<span className="group-hover/upload:opacity-100 group-focus-visible/upload:opacity-100" {...stylex.props(sx.pointerEventsNone, sx.absolute, sx.inset0, sx.grid, sx.placeItemsCenter, sx.roundedInherit, sx.bgBlack50, sx.textWhite, sx.opacity0, sx.transitionOpacity, sx.duration150)}>
											<IconArrowUpToLine size={20} />
										</span>
									</button>
									{settings.organizationIconUrl && (
										<OverlayAction
											icon={<IconTrash {...stylex.props(sx.textRed)} size={20} />}
											disabled={busy}
											onClick={removeIcon}
											aria-label="Remove organization icon"
											title="Remove icon"
											className="phone:pointer-events-auto! phone:opacity-100!"
										/>
									)}
								</div>
								<input
									ref={fileInput}
									type="file"
									disabled={busy}
									accept="image/*"
									{...stylex.props(sx.hidden)}
									onChange={(event) => {
										const file = event.target.files?.[0];
										event.target.value = "";
										if (file) void upload(file);
									}}
								/>
							</SettingRowControl>
						</SettingRow>
						<SettingRow>
							<SettingRowText>
								<SettingRowTitle>Organization name</SettingRowTitle>
							</SettingRowText>
							<input
								className={NAME_INPUT_CLASS}
								value={draft}
								maxLength={80}
								disabled={busy}
								onChange={(event) => setDraft(event.target.value)}
								onBlur={() => void commitName()}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
									else if (event.key === "Escape") setDraft(settings.organizationName);
								}}
								aria-label="Organization name"
							/>
						</SettingRow>
						{showDomain && (
							<SettingRow>
								<SettingRowText>
									<SettingRowTitle>Email domain</SettingRowTitle>
								</SettingRowText>
								<input
									className={NAME_INPUT_CLASS}
									value={domainDraft}
									maxLength={80}
									disabled={busy}
									placeholder="acme.com"
									inputMode="url"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									onChange={(event) => setDomainDraft(event.target.value)}
									onBlur={() => void commitDomain()}
									onKeyDown={(event) => {
										if (event.key === "Enter") event.currentTarget.blur();
										else if (event.key === "Escape")
											setDomainDraft(settings.organizationDomain);
									}}
									aria-label="Organization email domain"
								/>
							</SettingRow>
						)}
						<IdentityRows />
					</SettingCard>
					<SettingsHint>
						Shared by everyone in this organization. Clearing the name restores the
						product name. The domain is who belongs here, so an invite outside it
						stands out.
					</SettingsHint>
				</>
			) : (
				<SettingCardSkeleton rows={2} label="Loading organization settings" />
			)}
		</>
	);
}

export function GeneralPanel() {
	return (
		<SettingsPanel>
			<SettingsHeader title="General" className="phone:hidden" />
			<OrganizationProfileSection />
		</SettingsPanel>
	);
}
