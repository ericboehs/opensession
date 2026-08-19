import React, { useEffect, useState } from "react";
import {
	fetchOrganizationSettings,
	removeOrganizationIcon,
	saveOrganizationSettings,
	uploadOrganizationIcon,
	type OrganizationSettingsDto,
} from "../../lib/api";
import { pngFromImageFile } from "../../lib/icon-image";
import { REPO_TILE_INK, repoColor, repoIconFill } from "../../lib/repo-colors";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingRow,
	SettingRowControl,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
	settingsInputClass,
} from "../../ui/settings";
import { toast } from "../../ui/toast";
import { InlineAlert } from "../../ui/state";
import { IconArrowUpToLine, IconTrash } from "../icons";
import { IdentityCard } from "../SetupIdentity";

const NAME_INPUT_CLASS = cn(settingsInputClass, "w-[220px] max-w-full");

export function GeneralPanel() {
	const [settings, setSettings] = useState<OrganizationSettingsDto | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [iconFailed, setIconFailed] = useState(false);
	const fileInput = React.useRef<HTMLInputElement>(null);

	async function load(cancelled?: () => boolean) {
		setLoadError(null);
		try {
			const next = await fetchOrganizationSettings();
			if (cancelled?.()) return;
			setSettings(next);
			setDraft(next.organizationName);
		} catch (error: any) {
			if (cancelled?.()) return;
			const message = error?.message || "Couldn’t load organization settings";
			setLoadError(message);
			toast(message, { variant: "error" });
		}
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
		try {
			const next = await work();
			setSettings(next);
			setDraft(next.organizationName);
			setIconFailed(false);
			toast(message, { variant: "success" });
		} catch (error: any) {
			toast(error?.message || "Couldn’t save organization settings", {
				variant: "error",
			});
			if (settings) setDraft(settings.organizationName);
		} finally {
			setBusy(false);
		}
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

	async function upload(file: File) {
		await update(async () => {
			const png = await pngFromImageFile(file);
			return uploadOrganizationIcon(png);
		}, "Organization icon updated.");
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
		<SettingsPanel>
			<SettingsHeader title="General" className="phone:hidden" />
			{loadError && !settings ? (
				<InlineAlert onRetry={() => void load()}>{loadError}</InlineAlert>
			) : settings ? (
				<>
					<SettingCard>
						<SettingRow className="items-center">
							<SettingRowText>
								<SettingRowTitle>Upload icon</SettingRowTitle>
							</SettingRowText>
							<SettingRowControl className="flex flex-wrap items-center justify-end gap-2">
								{settings.organizationIconUrl && (
									<Button
										variant="ghost"
										icon={<IconTrash size={20} />}
										disabled={busy}
										onClick={() =>
											void update(removeOrganizationIcon, "Organization icon removed.")
										}
									>
										Remove
									</Button>
								)}
								<button
									type="button"
									disabled={busy}
									onClick={() => fileInput.current?.click()}
									aria-label={showIcon ? "Change organization icon" : "Upload organization icon"}
									className="focus-ring group relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg text-section-title font-semibold outline outline-1 outline-divider disabled:pointer-events-none"
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
											className="size-full object-cover"
											onError={() => setIconFailed(true)}
										/>
									) : (
										initials
									)}
									<span className="pointer-events-none absolute inset-0 grid place-items-center rounded-[inherit] bg-black/50 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
										<IconArrowUpToLine size={20} />
									</span>
								</button>
								<input
									ref={fileInput}
									type="file"
									disabled={busy}
									accept="image/*"
									className="hidden"
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
					</SettingCard>
					<SettingsHint>
						Shared by everyone in this workspace. Clearing the name restores the
						 product name.
					</SettingsHint>
				</>
			) : (
				<SettingCardSkeleton rows={2} label="Loading organization settings" />
			)}
			<SettingsGroupLabel>Identity</SettingsGroupLabel>
			<IdentityCard />
		</SettingsPanel>
	);
}
