import { useEffect, useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
} from "../../ui/settings";
import { Select, SettingRow } from "./shared";
import { InlineAlert } from "../../ui/state";
import { ReposSection } from "../SetupRepos";
import {
	configuredNewSessionRepo,
	fetchRepos,
	fetchWorktreeSettings,
	setNewSessionRepoApi,
	setSharedCheckoutMode,
	type RepoInfo,
	type SharedCheckoutMode,
	type WorktreeSettings,
} from "../../lib/api";
import { AUTO_REPO } from "../../lib/session-repo";
import { RepoTile } from "../RepoTile";
import { IconSparkle } from "../icons";
import { Radio, RadioGroup } from "../../ui/radio";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";
import { mergeStylexProps } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mt9: {
			marginTop: "36px"
	},
	flex: {
			display: "flex"
	},
	minH11: {
			minHeight: "44px"
	},
	cursorPointer: {
			cursor: "pointer"
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
	transitionBackgroundColor: {
			transitionProperty: "background-color",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	mt05: {
			marginTop: "2px"
	},
	minW0: {
			minWidth: "0"
	},
	block: {
			display: "block"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt1: {
			marginTop: "4px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
});

/**
 * Where a new session starts for everyone who hasn't set their own preference
 * (Settings → Preferences overrides this). Auto reads the prompt and picks.
 *
 * Deliberately not the same thing as which repo is "the default" internally:
 * that one is a fallback that must always name a real checkout, so it can't
 * say Auto.
 */
function SharedCheckoutSetting() {
	const [settings, setSettings] = useState<WorktreeSettings | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchWorktreeSettings()
			.then((value) => alive && setSettings(value))
			.catch((cause) => alive && setError(cause.message));
		return () => {
			alive = false;
		};
	}, []);

	if (!settings) {
		return error ? (
			<InlineAlert {...stylex.props(sx.mt9)}>{error}</InlineAlert>
		) : (
			<SettingCardSkeleton
				rows={1}
				label="Loading worktree settings"
				{...stylex.props(sx.mt9)}
			/>
		);
	}
	if (!settings.repos.length) return null;

	const repoNames = settings.repos.map((repo) => repo.label).join(", ");
	async function setMode(mode: SharedCheckoutMode) {
		const previous = settings;
		if (!previous || mode === previous.mode) return;
		setSettings({ ...previous, mode });
		setSaving(true);
		setError(null);
		await (async () => {
setSettings(await setSharedCheckoutMode(mode));
})().catch(async (cause: any) => {
setSettings(previous);
			setError(cause?.message || "Couldn’t save where sessions make changes");
}).finally(async () => {
setSaving(false);
});
	}

	return (
		<>
			<SettingsGroupLabel>How sessions make changes</SettingsGroupLabel>
			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}
			<SettingCard>
				<RadioGroup
					aria-label="How sessions make changes"
					value={settings.mode}
					disabled={saving}
					onValueChange={(mode) => void setMode(mode as SharedCheckoutMode)}
					className="[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']"
				>
					<label {...mergeStylexProps("hover:bg-hover", sx.flex, sx.minH11, sx.cursorPointer, sx.itemsStart, sx.gap3, sx.px5, sx.py4, sx.transitionBackgroundColor)}>
						<Radio value="shared" {...stylex.props(sx.mt05)} />
						<span {...stylex.props(sx.minW0)}>
							<span {...stylex.props(sx.block, sx.fontMedium, sx.textFg, typography.itemTitle)}>
								Local checkout
							</span>
							<span {...stylex.props(sx.mt1, sx.block, sx.textDim, typography.supporting)}>
								Edit {repoNames} directly. Changes appear there right away, and
								sessions share the same files.
							</span>
						</span>
					</label>
					<label {...mergeStylexProps("hover:bg-hover", sx.flex, sx.minH11, sx.cursorPointer, sx.itemsStart, sx.gap3, sx.px5, sx.py4, sx.transitionBackgroundColor)}>
						<Radio value="worktree" {...stylex.props(sx.mt05)} />
						<span {...stylex.props(sx.minW0)}>
							<span {...stylex.props(sx.block, sx.fontMedium, sx.textFg, typography.itemTitle)}>
								Separate pull request branch
							</span>
							<span {...stylex.props(sx.mt1, sx.block, sx.textDim, typography.supporting)}>
								Give each session an isolated Git worktree and branch. Changes
								stay separate from the local checkout, ready for a pull request.
							</span>
						</span>
					</label>
				</RadioGroup>
			</SettingCard>
			<SettingsHint>Only applies to new sessions.</SettingsHint>
		</>
	);
}

function DefaultRepoRow() {
	const [repos, setRepos] = useState<RepoInfo[]>([]);
	const [value, setValue] = useState("");
	useEffect(() => {
		// fetchRepos carries the setting alongside the list, so one load fills
		// both the options and the current choice.
		fetchRepos()
			.then((items) => {
				setRepos(items);
				setValue(configuredNewSessionRepo());
			})
			.catch(() => {});
	}, []);
	return (
		<SettingCard>
			<SettingRow
				title="Default repository"
				desc="Where a new session starts, for anyone who hasn't set their own. On Auto it reads the prompt and picks."
				control={
					<Select
						label="Default repository"
						value={value}
						options={[
							{
								value: AUTO_REPO,
								label: "Auto",
								icon: <IconSparkle size={16} />,
							},
							...repos.map((r) => ({
								value: r.id,
								label: r.label || r.id,
								icon: <RepoTile name={r.id} size={16} />,
							})),
						]}
						onChange={(next) => {
							setValue(next);
							void setNewSessionRepoApi(next).catch(() => {});
						}}
					/>
				}
			/>
		</SettingCard>
	);
}

// Workspace → Repositories: the registered repos, and the add flow, on a page
// of their own. Same section the Setup wizard's repos step renders — a repo
// added here and a repo added there are the same act. No restart banner:
// registering a repo takes effect immediately.

export function ReposPanel() {
	const { status, failed, refetch, applyRepo } = useSetupStatus();
	return (
		<SettingsPanel>
			<SettingsHeader
				title="Repositories"
				description="Register repositories and choose where their sessions work."
			/>
			{!status ? (
				// A failure is an alert, not a quiet label under a spinner: it used
				// to render in the loading register, so the sentence saying the
				// page had given up sat beside a mark saying it was still trying.
				failed ? (
					<InlineAlert>Couldn&rsquo;t load the repositories.</InlineAlert>
				) : (
					<>
						<SettingCardSkeleton rows={1} label="Loading repositories" />
						{/* mt-9 stands in for the group label above the list, which
						    counts the repos and so cannot be drawn before they
						    arrive. */}
						<SettingCardSkeleton rows={3} icon={28} {...stylex.props(sx.mt9)} />
					</>
				)
			) : (
				<>
					<DefaultRepoRow />
					<SharedCheckoutSetting />
					<ReposSection
						repos={status.repos}
						onChanged={refetch}
						onRepoUpdated={applyRepo}
					/>
				</>
			)}
		</SettingsPanel>
	);
}
