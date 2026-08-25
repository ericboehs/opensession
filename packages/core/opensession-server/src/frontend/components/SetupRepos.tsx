import React, { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { Popover } from "../ui/popover";
import { Switch } from "../ui/switch";
import { cn, mergeStylexProps } from "../ui/cn";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
	settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";
import { IconArrowUpToLine, IconPlus } from "./icons";
import { RepoTile } from "./RepoTile";
import { REPO_TILE_COLORS, REPO_TILE_INK, repoColor, repoIconFill } from "../lib/repo-colors";
import { repoLetter } from "../lib/repo-label";
import { pngFromImageFile } from "../lib/icon-image";
import { setupRepoDefaultBranch } from "../lib/setup-repo";
import {
	fetchRepos,
	notifyReposChanged,
	repoGithubAvatarUrl,
	setRepoAppearanceApi,
	uploadRepoIconApi,
	type RepoInfo,
} from "../lib/api";
import {
	StateChip,
	repoLifecycleState,
	setupRequest,
	type BrowseRepo,
	type SetupRepo,
	type SetupStatus,
} from "./setup-shared";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	itemsStart: {
			alignItems: "flex-start"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
	mt2: {
			marginTop: "8px"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsEnd: {
			alignItems: "flex-end"
	},
	gap2: {
			gap: "8px"
	},
	w44: {
			width: "176px"
	},
	mt15: {
			marginTop: "6px"
	},
	mt3: {
			marginTop: "12px"
	},
	grid: {
			display: "grid"
	},
	minH11: {
			minHeight: "44px"
	},
	maxW36rem: {
			maxWidth: "36rem"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gapX3: {
			columnGap: "12px"
	},
	gapY1: {
			rowGap: "4px"
	},
	py1: {
			paddingBlock: "4px"
	},
	minW0: {
			minWidth: "0"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	colSpan2: {
			gridColumn: "span 2/span 2"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	w248px: {
			width: "248px"
	},
	p3: {
			padding: "12px"
	},
	mb2: {
			marginBottom: "8px"
	},
	hidden: {
			display: "none"
	},
	hFull: {
			height: "100%"
	},
	wFull: {
			width: "100%"
	},
	roundedControl: {
			borderRadius: "calc(12px * var(--rf))"
	},
	objectCover: {
			objectFit: "cover"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderDashed: {
			borderStyle: "dashed"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	pt1: {
			paddingTop: "4px"
	},
	h5: {
			height: "20px"
	},
	w5: {
			width: "20px"
	},
	flex1: {
			flex: "1"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	text15px: {
			fontSize: "15px"
	},
	fontBold: {
			fontWeight: "var(--font-weight-bold)"
	},
	gap3: {
			gap: "12px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	px1: {
			paddingInline: "4px"
	},
	py2: {
			paddingBlock: "8px"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	mt05: {
			marginTop: "2px"
	},
	maxH320px: {
			maxHeight: "320px"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	px15: {
			paddingInline: "6px"
	},
	py05: {
			paddingBlock: "2px"
	},
	text092em: {
			fontSize: ".92em"
	},
	mt25: {
			marginTop: "10px"
	},
	borderT: {
			borderTopStyle: "solid",
			borderTopWidth: "1px"
	},
	pt3: {
			paddingTop: "12px"
	},
	mt1: {
			marginTop: "4px"
	},
	maxH240px: {
			maxHeight: "240px"
	},
	colorGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(6,minmax(0,1fr))",
		gap: "8px",
		transitionProperty: "opacity",
		transitionDuration: "150ms",
	},
	opacity40: { opacity: 0.4 },
	tileChoice: {
		width: "28px",
		height: "28px",
		borderRadius: "calc(12px * var(--rf))",
		outlineStyle: "none",
		transitionProperty: "transform",
		transitionDuration: "var(--dur-micro)",
		":hover": { transform: "scale(1.1)" },
		":focus-visible": {
			outline: "2px solid var(--accent-ink)",
			outlineOffset: "2px",
		},
	},
	tileChoiceActive: {
		boxShadow: "0 0 0 2px var(--bg-panel), 0 0 0 4px var(--text)",
	},
});

// Settings → Setup → Repositories: the registered repos sessions work in,
// plus an add flow. With a GitHub credential (a connected account or the bot
// token) the add flow browses the reachable repos; without one it falls back
// to a manual owner/name entry. When the code.storage integration is
// configured, its org's repos are offered in their own section alongside
// GitHub. Registering clones the repo server-side, so an add can take tens of
// seconds — the row keeps a working state the whole way and nothing here
// times out early.

export function ReposSection({
	repos,
	onChanged,
	onRepoUpdated,
	compact = false,
}: {
	repos: SetupStatus["repos"];
	onChanged: () => void | Promise<void>;
	onRepoUpdated?: (
		updated: Pick<SetupRepo, "id"> &
			Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
	) => void;
	compact?: boolean;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	// Focused when the picker opens, so a long list is one keystroke from
	// being filtered. Only one of the picker's two inputs renders at a time.
	const pickerInput = useRef<HTMLInputElement>(null);
	// Tile appearance rides on the repo list rather than the setup status: the
	// same payload every tile in the app reads, so what this page shows and
	// what the sidebar paints can't drift apart.
	const [appearance, setAppearance] = useState<Map<string, RepoInfo>>(new Map());
	const repoIds = repos.map((repo) => repo.id).join("\0");
	const loadAppearance = async () => {
		const list = await fetchRepos().catch(() => []);
		setAppearance(new Map(list.map((r) => [r.id, r])));
	};
	useEffect(() => {
		loadAppearance();
	}, [loadAppearance, repoIds]);
	return (
		<>
			{/* The label is the count: the page and the wizard step are both
			    already titled "Repositories", so repeating the word says
			    nothing, while how many are registered is worth reading. */}
			<SettingsGroupLabel
				// first:mt-0 because this section opens the setup wizard's repos
				// step, where the label needs no space above it. On the settings
				// page it follows the default-repository card and keeps the
				// group's own mt-9, which is what separates the two.
				className="first:mt-0"
				actions={
					<Button
						size="sm"
						icon={<IconPlus size={16} />}
						onClick={() => setPickerOpen(true)}
					>
						Add repository
					</Button>
				}
			>
				{repos.length === 0
					? "No repositories"
					: repos.length === 1
						? "1 repository"
						: `${repos.length} repositories`}
			</SettingsGroupLabel>
			{/* On top rather than inline: the picker is a list of its own, and
			    pushing the registered repos down the page to browse a second
			    list made the two read as one. Adding stays a detour. */}
			<Modal.Root open={pickerOpen} onOpenChange={setPickerOpen}>
				<Modal.Content widthClassName="max-w-[34rem]" initialFocus={pickerInput}>
					<Modal.Header
						title="Add repository"
						description="Clone a repository onto the server so sessions can work in it."
					/>
					<AddRepoPicker inputRef={pickerInput} onAdded={onChanged} />
				</Modal.Content>
			</Modal.Root>
			<SettingCard>
				{repos.length === 0 ? (
					<EmptyState placement="row">
						No repositories registered. Ask and Code sessions need a repo to work
						in, so add one above.
					</EmptyState>
				) : (
					repos.map((repo) => {
						if (!compact) {
							return (
								<RepositoryRow
									key={repo.id}
									repo={repo}
									appearance={appearance.get(repo.id)}
									onAppearanceChanged={loadAppearance}
									onChanged={onChanged}
									onRepoUpdated={onRepoUpdated}
								/>
							);
						}
						const lifecycle = repoLifecycleState(repo);
						return (
							<SettingRow key={repo.id}>
								<RepoTileButton
									repo={appearance.get(repo.id)}
									id={repo.id}
									onChanged={loadAppearance}
								/>
								<SettingRowText>
									<SettingRowTitle>{repo.label}</SettingRowTitle>
								</SettingRowText>
								<StateChip tone={lifecycle.tone} label={lifecycle.label} />
							</SettingRow>
						);
					})
				)}
			</SettingCard>
			<SettingsHint>
				Registering clones the repo onto the server. Code sessions use isolated
				worktrees by default. Commit <code>.agents/</code> scripts to provision those
				worktrees and boot previews. See docs/repo-lifecycle.md.
			</SettingsHint>
		</>
	);
}

function RepositoryRow({
	repo,
	appearance,
	onAppearanceChanged,
	onChanged,
	onRepoUpdated,
}: {
	repo: SetupStatus["repos"][number];
	appearance: RepoInfo | undefined;
	onAppearanceChanged: () => Promise<void>;
	onChanged: () => void | Promise<void>;
	onRepoUpdated?: (
		updated: Pick<SetupRepo, "id"> &
			Partial<Pick<SetupRepo, "defaultBranch" | "isolatedWorktrees">>,
	) => void;
}) {
	const lifecycle = repoLifecycleState(repo);
	// A hot frontend rebuild can briefly run against the prior setup-status
	// payload, which omitted defaultBranch. The repository payload already had
	// it, so use that as the compatibility fallback instead of crashing while
	// the backend waits for its deliberate restart.
	const defaultBranch = setupRepoDefaultBranch(repo, appearance);
	const [branch, setBranch] = useState(defaultBranch);
	const [isolatedWorktrees, setIsolatedWorktrees] = useState(
		repo.isolatedWorktrees,
	);
	const [saving, setSaving] = useState<"branch" | "worktrees" | null>(null);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [worktreeError, setWorktreeError] = useState<string | null>(null);
	const branchErrorId = useId();
	const worktreeErrorId = useId();
	const worktreeDescriptionId = useId();

	useEffect(() => {
		setBranch(defaultBranch);
	}, [defaultBranch]);
	useEffect(() => {
		setIsolatedWorktrees(repo.isolatedWorktrees);
	}, [repo.isolatedWorktrees]);

	const normalized = branch.trim();
	const changed = normalized !== defaultBranch;

	async function saveBranch(event: React.FormEvent) {
		event.preventDefault();
		if (!normalized || !changed || saving) return;
		setSaving("branch");
		setBranchError(null);
		await (async () => {
const updated = await setupRequest<{
				id: string;
				defaultBranch: string;
			}>(`/api/setup/repos/${encodeURIComponent(repo.id)}`, {
				method: "PATCH",
				json: { defaultBranch: normalized },
			});
			setBranch(updated.defaultBranch);
			if (onRepoUpdated) onRepoUpdated(updated);
			else await onChanged();
			toast(`${repo.label} default branch updated`);
})().catch(async (e: any) => {
setBranchError(e.message);
}).finally(async () => {
setSaving(null);
});
	}

	async function saveWorktreeMode(next: boolean) {
		if (saving) return;
		const previous = isolatedWorktrees;
		setIsolatedWorktrees(next);
		setSaving("worktrees");
		setWorktreeError(null);
		await (async () => {
const updated = await setupRequest<{
				id: string;
				defaultBranch: string;
				isolatedWorktrees: boolean;
			}>(`/api/setup/repos/${encodeURIComponent(repo.id)}`, {
				method: "PATCH",
				json: { isolatedWorktrees: next },
			});
			setIsolatedWorktrees(updated.isolatedWorktrees);
			if (onRepoUpdated) onRepoUpdated(updated);
			else await onChanged();
			toast(`${repo.label} worktree setting updated`);
})().catch(async (e: any) => {
setIsolatedWorktrees(previous);
			setWorktreeError(e.message);
}).finally(async () => {
setSaving(null);
});
	}

	return (
		<SettingRow {...stylex.props(sx.itemsStart)}>
			<RepoTileButton
				repo={appearance}
				id={repo.id}
				onChanged={onAppearanceChanged}
			/>
			<SettingRowText>
				<SettingRowTitle>{repo.label}</SettingRowTitle>
				<SettingRowDescription {...stylex.props(sx.truncate, sx.fontMono, typography.meta)}>
					{repo.path}
				</SettingRowDescription>
				<form {...stylex.props(sx.mt2, sx.flex, sx.flexWrap, sx.itemsEnd, sx.gap2)} onSubmit={saveBranch}>
					<Field label="Default branch" {...stylex.props(sx.w44)}>
						<Input
							{...stylex.props(sx.fontMono)}
							value={branch}
							onChange={(event) => {
								setBranch(event.target.value);
								setBranchError(null);
							}}
							disabled={!!saving}
							aria-invalid={!!branchError}
							aria-describedby={branchError ? branchErrorId : undefined}
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
						/>
					</Field>
					<Button
						type="submit"
						size="sm"
						disabled={!normalized || !changed || !!saving}
					>
						{saving === "branch" ? "Saving…" : "Save"}
					</Button>
				</form>
				{branchError && (
					<InlineAlert id={branchErrorId} {...stylex.props(sx.mt15)}>
						{branchError}
					</InlineAlert>
				)}
				<div {...mergeStylexProps("grid-cols-[minmax(0,1fr)_auto] phone:-ml-11 phone:max-w-[calc(100%+2.75rem)]", sx.mt3, sx.grid, sx.minH11, sx.maxW36rem, sx.itemsCenter, sx.gapX3, sx.gapY1, sx.py1)}>
					<span {...stylex.props(sx.minW0, sx.fontMedium, sx.textFg, typography.label)}>
						Use isolated worktrees
					</span>
					<Switch
						aria-label={`Use isolated worktrees for ${repo.label}`}
						aria-describedby={`${worktreeDescriptionId}${worktreeError ? ` ${worktreeErrorId}` : ""}`}
						checked={isolatedWorktrees}
						disabled={!!saving}
						onCheckedChange={(next) => void saveWorktreeMode(next)}
					/>
					<span
						id={worktreeDescriptionId}
						{...stylex.props(sx.colSpan2, sx.textDim, typography.meta)}
					>
						Give new code sessions a separate worktree. Existing sessions stay put.
					</span>
				</div>
				{worktreeError && (
					<InlineAlert id={worktreeErrorId} {...stylex.props(sx.mt15)}>
						{worktreeError}
					</InlineAlert>
				)}
			</SettingRowText>
			<StateChip tone={lifecycle.tone} label={lifecycle.label} />
		</SettingRow>
	);
}

/**
 * The repo's tile, and the controls behind it. The tile is the trigger because
 * it's the thing being edited — a separate "edit tile" button would say less
 * than the picture it changes.
 *
 * One grid of tiles, because there is one question: what does this repo look
 * like? A color and an icon used to be separate controls, which made picking a
 * color while art was set do nothing you could see. Here every cell is the
 * tile you'd get — the palette colors carrying the repo's letter, the owner's
 * GitHub avatar (fetched up front, so the picture itself is the choice rather
 * than something a "Fetch from GitHub" press might produce), and art of your
 * own — and picking a color is also how you take art back off.
 *
 * A repo wears a colored letter by default: GitHub has no per-repo art, so
 * taking the owner's avatar for every repo put one identical tile on all of
 * them.
 */
function RepoTileButton({
	id,
	repo,
	onChanged,
}: {
	id: string;
	repo: RepoInfo | undefined;
	onChanged: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The avatar is offered only once we know there is one: the route 404s for
	// a repo with no GitHub remote, and GitHub can be unreachable.
	const [avatarOk, setAvatarOk] = useState(false);
	const fileInput = React.useRef<HTMLInputElement>(null);

	async function run(work: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		setError(null);
		await (async () => {
await work();
			await onChanged();
})().catch(async (e: any) => {
setError(e.message);
}).finally(async () => {
setBusy(false);
});
	}

	const apply = (patch: { color?: string | null; icon?: "github" | null }) =>
		run(() => setRepoAppearanceApi(id, patch));

	// On automatic when nothing was chosen for it and it wears no art.
	const autoActive = !repo?.hasIcon && !repo?.colorChosen;

	async function upload(file: File) {
		await run(async () => {
			const png = await pngFromImageFile(file);
			await uploadRepoIconApi(id, png);
		});
	}

	return (
		<Popover.Root>
			<Popover.Trigger {...mergeStylexProps("focus-visible:ring-2 focus-visible:ring-[var(--accent,#6b8afd)]", sx.shrink0, sx.roundedMd, sx.outlineNone)}
				aria-label={`Change ${id}'s icon`}
			>
				<RepoTile name={id} size={28} />
			</Popover.Trigger>
			<Popover.Popup {...stylex.props(sx.w248px, sx.p3)} initialFocus>
				<div {...stylex.props(sx.mb2, sx.fontMedium, sx.textDim, typography.meta)}>Icon</div>
				{/* Faded while automatic is on: these choices aren't in effect.
				    Still live, though — picking one is how you leave automatic,
				    so the fade never becomes a mode you have to escape first. */}
				<div {...stylex.props(sx.colorGrid, autoActive && sx.opacity40)}>
					{REPO_TILE_COLORS.map((color) => (
						<TileChoice
							key={color}
							// Named by what it does, not by its hex: "#b04e90"
							// tells a screen reader nothing.
							label={`Letter icon, color ${REPO_TILE_COLORS.indexOf(color) + 1} of ${REPO_TILE_COLORS.length}`}
							// Picking a color takes art off too — otherwise the
							// choice would be invisible on a repo wearing art.
							active={!autoActive && !repo?.hasIcon && repo?.color === color}
							disabled={busy}
							onClick={() => apply({ color, icon: null })}
						>
							<LetterTile id={id} color={color} />
						</TileChoice>
					))}
					{/* Fetched as soon as the popover opens, so the avatar is a
					    picture you pick rather than one a button might produce.
					    The route 404s when there's nothing to take, and the
					    choice simply doesn't appear. */}
					<img
						src={repoGithubAvatarUrl(id)}
						alt=""
						{...stylex.props(sx.hidden)}
						onLoad={() => setAvatarOk(true)}
						onError={() => setAvatarOk(false)}
					/>
					{avatarOk && (
						<TileChoice
							label={`${repo?.ghRepo?.split("/")[0]}’s GitHub avatar`}
							active={repo?.iconSource === "github"}
							disabled={busy}
							onClick={() => apply({ icon: "github" })}
						>
							<img
								src={repoGithubAvatarUrl(id)}
								alt=""
								{...stylex.props(sx.hFull, sx.wFull, sx.roundedControl, sx.objectCover)}
							/>
						</TileChoice>
					)}
					<TileChoice
						label="Upload an image"
						active={repo?.iconSource === "upload"}
						disabled={busy}
						onClick={() => fileInput.current?.click()}
					>
						<span {...stylex.props(sx.flex, sx.hFull, sx.wFull, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.border, sx.borderDashed, sx.borderLine, sx.textDim)}>
							<IconArrowUpToLine size={14} />
						</span>
					</TileChoice>
					<input
						ref={fileInput}
						type="file"
						accept="image/*"
						{...stylex.props(sx.hidden)}
						onChange={(e) => {
							const file = e.target.files?.[0];
							// Cleared so picking the same file twice still fires.
							e.target.value = "";
							if (file) upload(file);
						}}
					/>
				</div>
				{/* The default, as a switch: it's a mode, not a thirteenth
				    choice. Off pins whatever it was giving, so leaving
				    automatic never lands the repo somewhere it wasn't. */}
				<label {...stylex.props(sx.mt3, sx.flex, sx.cursorPointer, sx.itemsCenter, sx.gap2, sx.pt1)}>
					<span {...stylex.props(sx.h5, sx.w5, sx.shrink0)}>
						<LetterTile id={id} color={repo?.autoColor} />
					</span>
					<span {...stylex.props(sx.minW0, sx.flex1, sx.textFg, typography.controlLabel)}>
						Automatic
					</span>
					<Switch
						checked={autoActive}
						disabled={busy}
						onCheckedChange={(on: boolean) =>
							apply(
								on
									? { color: null, icon: null }
									: { color: repo?.autoColor ?? repo?.color ?? null },
							)
						}
					/>
				</label>
				<div {...stylex.props(sx.mt15, sx.leadingRelaxed, sx.textFaint, typography.supporting)}>
					{busy
						? "Working…"
						: avatarOk
							? `Automatic keeps this repo on a color no other repo has. The avatar is ${repo?.ghRepo?.split("/")[0]}’s. Every repo that owner has shows the same picture.`
							: "Automatic keeps this repo on a color no other repo has."}
				</div>
				{error && <InlineAlert {...stylex.props(sx.mt2)}>{error}</InlineAlert>}
			</Popover.Popup>
		</Popover.Root>
	);
}

/** One cell of the tile grid: a preview of what picking it would give. */
function TileChoice({
	label,
	active,
	disabled,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={!!active}
			disabled={disabled}
			onClick={onClick}
			{...stylex.props(sx.tileChoice, active && sx.tileChoiceActive)}
		>
			{children}
		</button>
	);
}

/** The letter tile as this color would look. Not RepoTile: that paints the
 *  art when a repo has any, and these cells are previews of not having it. */
function LetterTile({ id, color }: { id: string; color?: string }) {
	return (
		<span
			{...stylex.props(sx.flex, sx.hFull, sx.wFull, sx.itemsCenter, sx.justifyCenter, sx.roundedControl, sx.text15px, sx.fontBold)}
			style={{ background: repoIconFill(color ?? repoColor(id)), color: REPO_TILE_INK }}
		>
			{repoLetter(id)}
		</span>
	);
}

interface BrowseResult {
	source: "user" | "bot" | null;
	repos: BrowseRepo[];
}

/** GET /api/setup/codestorage/repos — `source: null` when the code.storage
 * integration isn't configured (the wizard probes it unconditionally). */
interface CsBrowseResult {
	source: "org" | null;
	repos: BrowseRepo[];
}

type RepoSource = "github" | "codestorage";

function filterRepos(repos: BrowseRepo[], filter: string): BrowseRepo[] {
	const q = filter.trim().toLowerCase();
	if (!q) return repos;
	return repos.filter(
		(r) =>
			r.fullName.toLowerCase().includes(q) ||
			(r.description ?? "").toLowerCase().includes(q),
	);
}

function RepoPickRow({
	repo,
	registered,
	working,
	disabled,
	onAdd,
}: {
	repo: BrowseRepo;
	registered: boolean;
	working: boolean;
	disabled: boolean;
	onAdd: () => void;
}) {
	return (
		<div {...mergeStylexProps("last:border-b-0", sx.flex, sx.itemsCenter, sx.gap3, sx.borderB, sx.borderLine, sx.px1, sx.py2)}>
			<div {...stylex.props(sx.minW0, sx.flex1)}>
				<div {...stylex.props(sx.flex, sx.minW0, sx.itemsBaseline, sx.gap2)}>
					<span {...stylex.props(sx.truncate, sx.fontMedium, sx.textFg, typography.controlLabel)}>
						{repo.fullName}
					</span>
					{repo.private && (
						<Badge>
							private
						</Badge>
					)}
				</div>
				{repo.description && (
					<div {...stylex.props(sx.mt05, sx.truncate, sx.textFaint, typography.supporting)}>
						{repo.description}
					</div>
				)}
			</div>
			<Button
				size="sm"
				variant={registered ? "ghost" : "default"}
				disabled={registered || disabled}
				onClick={onAdd}
			>
				{registered ? "Added" : working ? "Cloning…" : "Add"}
			</Button>
		</div>
	);
}

function AddRepoPicker({
	inputRef,
	onAdded,
}: {
	/** Focused once the list resolves. Which input exists depends on whether
	 *  there's a credential to browse with, so both branches take it. */
	inputRef?: React.RefObject<HTMLInputElement | null>;
	onAdded: () => void | Promise<void>;
}) {
	const [browse, setBrowse] = useState<BrowseResult | null>(null);
	const [browseFailed, setBrowseFailed] = useState(false);
	// code.storage list, probed alongside GitHub. Stays null until the probe
	// answers; an unconfigured integration answers `source: null` (no section).
	const [csBrowse, setCsBrowse] = useState<CsBrowseResult | null>(null);
	// Configured-but-failing (bad key path, API outage): the route answers 502
	// with the server's error — distinct from "not configured", which hides the
	// section entirely.
	const [csError, setCsError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [addingRepo, setAddingRepo] = useState<string | null>(null);
	const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState("");

	useEffect(() => {
		let cancelled = false;
		(async () => {
			await (async () => {
const body = await setupRequest<BrowseResult>("/api/setup/github/repos");
				if (!cancelled) setBrowse(body);
})().catch(async () => {
if (!cancelled) setBrowseFailed(true);
});
		})();
		(async () => {
			await (async () => {
const body = await setupRequest<CsBrowseResult>(
					"/api/setup/codestorage/repos",
				);
				if (!cancelled) setCsBrowse(body);
})().catch(async (e: any) => {
// A throw means configured-but-failing (the route answers 200 with
				// source: null when unconfigured) — surface the server's error
				// instead of silently hiding the section. GitHub is unaffected.
				if (!cancelled)
					setCsError(e?.message || "Couldn’t reach code.storage right now.");
});
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// The list arrives after the dialog has opened, so the dialog's initial
	// focus finds no field to land on. Focus it the moment it exists.
	useEffect(() => {
		if (browse || browseFailed) inputRef?.current?.focus();
	}, [browse, browseFailed, inputRef]);

	const filtered = (filterRepos(browse?.repos ?? [], filter));
	const csFiltered = (filterRepos(csBrowse?.repos ?? [], filter));
	const csConfigured = csBrowse?.source === "org";

	async function addRepo(fullName: string, source: RepoSource = "github") {
		if (addingRepo) return;
		const key = `${source}:${fullName}`;
		setAddingRepo(key);
		setError(null);
		await (async () => {
// Registering clones server-side — can take tens of seconds. No client
			// timeout; the button holds its working state until the server answers.
			// code.storage repos reuse the same submit shape with a source marker.
			await setupRequest("/api/setup/repos", {
				method: "POST",
				json:
					source === "codestorage" ? { source, fullName } : { fullName },
			});
			setAdded((prev) => new Set(prev).add(key));
			setManual("");
			toast(`${fullName} registered`);
			notifyReposChanged();
			await onAdded();
})().catch(async (e: any) => {
setError(e.message);
}).finally(async () => {
setAddingRepo(null);
});
	}

	const manualValid = /^[^/\s]+\/[^/\s]+$/.test(manual.trim());
	const totalListed =
		(browse?.source ? browse.repos.length : 0) +
		(csConfigured ? (csBrowse?.repos.length ?? 0) : 0);

	return (
		// No surface of its own: the dialog is already the card this sits on.
		<div>
			{!browse && !browseFailed ? (
				<LoadingState placement="row">Looking up your GitHub repositories…</LoadingState>
			) : browse && browse.source !== null ? (
				<>
					<input
						ref={inputRef}
						className={settingsInputClass}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder={`Filter ${totalListed || browse.repos.length} ${
							(totalListed || browse.repos.length) === 1
								? "repository"
								: "repositories"
						}…`}
						aria-label="Filter repositories"
						autoCapitalize="none"
						spellCheck={false}
					/>
					<div {...stylex.props(sx.mt2, sx.maxH320px, sx.overflowYAuto)}>
						{filtered.length === 0 ? (
							<EmptyState placement="row" {...stylex.props(sx.px1)}>
								No repositories match.
							</EmptyState>
						) : (
							filtered.map((r) => (
								<RepoPickRow
									key={r.fullName}
									repo={r}
									registered={r.registered || added.has(`github:${r.fullName}`)}
									working={addingRepo === `github:${r.fullName}`}
									disabled={addingRepo !== null}
									onAdd={() => addRepo(r.fullName)}
								/>
							))
						)}
					</div>
					<div {...stylex.props(sx.mt2, sx.textFaint, typography.meta)}>
						Browsing as the {browse.source === "user" ? "connected account" : "bot"}.
						Only repos that credential can reach are listed.
					</div>
				</>
			) : (
				<>
					<div {...stylex.props(sx.leadingRelaxed, sx.textDim, typography.supporting)}>
						{browseFailed ? (
							<>Couldn&rsquo;t load the GitHub repo list right now.</>
						) : (
							<>
								No GitHub credential yet, so the repo list can&rsquo;t be browsed.
								Connect your GitHub account under Settings → Connections to list
								your private repos here. (Operators can instead set{" "}
								<code {...stylex.props(sx.roundedSm, sx.bgSurface, sx.px15, sx.py05, sx.fontMono, sx.text092em, sx.textFg)}>
									GITHUB_API_TOKEN
								</code>{" "}
								via the GitHub integration card below.)
							</>
						)}{" "}
						You can still register a repo by name:
					</div>
					<div {...stylex.props(sx.mt25, sx.flex, sx.itemsCenter, sx.gap2)}>
						<input
							ref={inputRef}
							className={cn(settingsInputClass, stylex.props(sx.flex1, sx.fontMono).className)}
							value={manual}
							onChange={(e) => setManual(e.target.value)}
							placeholder="owner/name"
							aria-label="Repository full name"
							autoCapitalize="none"
							spellCheck={false}
							onKeyDown={(e) => {
								if (e.key === "Enter" && manualValid && !addingRepo)
									addRepo(manual.trim());
							}}
						/>
						<Button
							variant="primary"
							disabled={!manualValid || addingRepo !== null}
							onClick={() => addRepo(manual.trim())}
						>
							{addingRepo ? "Cloning…" : "Add"}
						</Button>
					</div>
				</>
			)}
			{(csConfigured || csError) && (
				<>
					<div {...stylex.props(sx.mt3, sx.borderT, sx.borderLine, sx.pt3, sx.fontMedium, sx.textDim, typography.meta)}>
						code.storage
					</div>
					{csError ? (
						<InlineAlert {...stylex.props(sx.mt15)}>
							code.storage is configured but its repo list failed: {csError}
						</InlineAlert>
					) : (
						<div {...stylex.props(sx.mt1, sx.maxH240px, sx.overflowYAuto)}>
							{csFiltered.length === 0 ? (
								<EmptyState placement="row" {...stylex.props(sx.px1)}>
									{filter.trim()
										? "No code.storage repositories match."
										: "No repositories visible to the org's signing key."}
								</EmptyState>
							) : (
								csFiltered.map((r) => (
									<RepoPickRow
										key={r.fullName}
										repo={r}
										registered={
											r.registered || added.has(`codestorage:${r.fullName}`)
										}
										working={addingRepo === `codestorage:${r.fullName}`}
										disabled={addingRepo !== null}
										onAdd={() => addRepo(r.fullName, "codestorage")}
									/>
								))
							)}
						</div>
					)}
				</>
			)}
			{error && <InlineAlert {...stylex.props(sx.mt25)}>{error}</InlineAlert>}
		</div>
	);
}
