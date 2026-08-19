import type {
	FilterState,
	GroupBy,
	PrsFilter,
	SortBy,
} from "../../lib/sidebar-filter";
import {
	DENSITY_OPTIONS,
	getSidebarDensity,
	onSidebarDensityChanged,
	setSidebarDensity,
	type SidebarDensity,
} from "../../lib/sidebar-density";
import { AGENT_PERSON_KEY } from "../../lib/automation-audience";
import { useIsPhone } from "../../hooks/useIsPhone";
import { Menu } from "../../ui/menu";
import { SwitchIndicator } from "../../ui/switch";
import { cn } from "../../ui/cn";
import { RepoTile, repoLabel } from "../RepoTile";
import {
	IconChevronDown,
	IconChevronRight,
	IconRobot,
	IconSliders,
} from "../icons";
import { UserAvatar } from "../UserAvatar";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// ── Filter popover ─────────────────────────────────────────────────────────
// A small floating panel (anchored under the filter button) holding the view
// controls for the session list: how it is grouped, which repo and person it
// is scoped to, what it hides, how it is sorted, and how tight its rows are.
// Rendered in a portal so it can overflow the narrow sidebar.

interface SelectOption {
	value: string;
	label: string;
	icon?: React.ReactNode;
}

/** Full-screen transparent catcher that closes the popover on outside click.
 *  The row menus portal above it (Base UI positions them at z-10001), so a
 *  press inside an open menu never reaches this. */
const BACKDROP = "fixed inset-0 z-[300]";

/** The panel itself, portalled and fixed-positioned at the anchor: the app's
 *  popup surface, so it reads as the same object as every menu it opens.
 *
 *  Padding is 12px because the rows inside carry `rounded-md` (7px × --rf) and
 *  the panel `rounded-popup` (16px × --rf): 7 + 12 lands on 16 once both scale
 *  together, which is the concentric-corner rule. `gap-0.5` keeps two adjacent
 *  hover washes from fusing into one block. */
const FILTER_POPOVER =
	"fixed z-[301] flex flex-col gap-0.5 rounded-popup bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] " +
	"p-3 smooth-shadow-ring-md animate-[hovercard-in_var(--dur-micro)_var(--ease)]";

/** One control per row, and the row IS the control: the setting's name on the
 *  left, its current value and a chevron on the right.
 *
 *  These wear the popup's vocabulary (a menu row's corner and hover wash), not
 *  the field's. A bordered field per row put seven of the strong hairline on a
 *  290px panel whose whole job is to be quiet, and a 7px box inside a 16px
 *  panel corner reads square; boxes sized to their own content also left-ragged
 *  the column. Taking the frames away leaves the values themselves as the only
 *  thing to read, and the chevrons land on one x.
 *
 *  The phone step is the row's own, not the panel's: 36px is a comfortable
 *  pointer row and a tight thumb one, and the whole row is the target now, so
 *  the padding is the only thing standing between it and 44. */
const FILTER_ROW =
	"flex w-full cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 phone:py-3 text-left text-item-title hover:bg-hover data-[popup-open]:bg-hover";

/** The leading glyph in a row and in its menu: one 16px box either way, so a
 *  list where only some options carry one keeps its labels on a single x. */
const GLYPH_SLOT = "flex size-4 shrink-0 items-center justify-center text-dim";

/** The options themselves. Shared, because the same question is asked from
 *  two places now: a row on the panel, and a row inside the Advanced menu. */
function ValueOptions({
	value,
	options,
	onSelect,
}: {
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
}) {
	const glyphs = options.some((option) => option.icon);
	return (
		<Menu.RadioGroup
			value={value}
			onValueChange={(next) => onSelect(String(next))}
		>
			{options.map((option) => (
				// `closeOnClick`, because this list is a value picker: Base UI
				// leaves a radio item's menu open by default, which is right
				// for a menu you keep toggling things in and wrong for one
				// answering a single question.
				<Menu.RadioItem
					key={option.value}
					value={option.value}
					closeOnClick
					className="justify-between gap-3"
				>
					<span className="flex min-w-0 items-center gap-2">
						{glyphs && <span className={GLYPH_SLOT}>{option.icon}</span>}
						<span className="min-w-0 truncate">{option.label}</span>
					</span>
					<Menu.Check on={option.value === value} />
				</Menu.RadioItem>
			))}
		</Menu.RadioGroup>
	);
}

function FilterRow({
	label,
	value,
	options,
	onSelect,
	footer,
}: {
	label: string;
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
	/** Rows under the options, below a rule: a setting about the things the
	 *  options name, rather than another one of them to pick. */
	footer?: React.ReactNode;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<Menu.Root>
			<Menu.Trigger className={FILTER_ROW}>
				<span className="shrink-0 text-dim">{label}</span>
				<span className="ml-auto flex min-w-0 items-center gap-2 text-fg">
					{current?.icon && <span className={GLYPH_SLOT}>{current.icon}</span>}
					<span className="truncate">{current?.label ?? value}</span>
					<IconChevronDown size={16} className="-mr-0.5 shrink-0 text-faint" />
				</span>
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={6}>
				<ValueOptions value={value} options={options} onSelect={onSelect} />
				{footer && (
					<>
						<Menu.Separator />
						{footer}
					</>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}

/** The same control as a row inside the Advanced menu: label, current value,
 *  and its options one level in. Reads as a menu row rather than a panel row,
 *  because that is where it now lives. */
function FilterSubmenu({
	label,
	value,
	options,
	onSelect,
}: {
	label: string;
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
}) {
	const current = options.find((option) => option.value === value);
	return (
		<Menu.SubmenuRoot>
			<Menu.SubmenuTrigger className="justify-between gap-3">
				<span className="truncate">{label}</span>
				<span className="flex flex-none items-center gap-2 text-dim">
					{current?.icon && <span className={GLYPH_SLOT}>{current.icon}</span>}
					<span className="truncate">{current?.label ?? value}</span>
					<IconChevronRight className="shrink-0 text-faint" size={17} />
				</span>
			</Menu.SubmenuTrigger>
			<Menu.Popup>
				<ValueOptions value={value} options={options} onSelect={onSelect} />
			</Menu.Popup>
		</Menu.SubmenuRoot>
	);
}

export function FilterPopover({
	anchor,
	filter,
	repos,
	people,
	currentUser,
	onChange,
	onClose,
	onCustomize,
}: {
	anchor: HTMLElement | null;
	filter: FilterState;
	repos: string[];
	people: Array<{ key: string; label: string }>;
	currentUser: string;
	onChange: (patch: Partial<FilterState>) => void;
	onClose: () => void;
	onCustomize: () => void;
}) {
	// Row density is a property of this list, so it sits with the other view
	// controls rather than only in settings. It is a stored preference, not part
	// of FilterState — hence its own state here, kept live by the pref's change
	// event so the Appearance switch and this row never disagree.
	// Both hooks run before the `anchor` early return: an unmounted anchor must
	// not change how many hooks this component calls.
	const isPhone = useIsPhone();
	const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
	useEffect(
		() => onSidebarDensityChanged(() => setDensity(getSidebarDensity())),
		[],
	);

	if (!anchor) return null;
	const r = anchor.getBoundingClientRect();
	const width = 290;
	const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
	const top = r.bottom + 6;

	const repoOptions: SelectOption[] = [
		{ value: "all", label: "All repos" },
		...repos.map((name) => ({
			value: name,
			label: repoLabel(name),
			icon: <RepoTile name={name} size={16} />,
		})),
	];

	// You first (the default), then teammates and the agent, the aggregate
	// Backlog lens, and "Everyone" last. Owner-focused views retain their own
	// Backlog rows.
	const meKey = currentUser.toLowerCase();
	const personAvatar = (name: string) => <UserAvatar name={name} size={16} />;
	// The agent is one of the people in this list: it owns every automation
	// nobody has taken. It has no photo, and an initial tile would read as a
	// teammate you don't recognise, so it wears the machine face automation
	// rows already use.
	const personIcon = (key: string, label: string) =>
		key === AGENT_PERSON_KEY ? (
			<span className="inline-flex size-4 shrink-0 items-center justify-center rounded-avatar bg-active text-dim">
				<IconRobot size={13} />
			</span>
		) : (
			personAvatar(label)
		);
	const personOptions: SelectOption[] = [
		{ value: "me", label: `${currentUser} (you)`, icon: personAvatar(currentUser) },
		...people
			.filter(({ key }) => key !== meKey)
			.map(({ key, label }) => ({
				value: key,
				label,
				icon: personIcon(key, label),
			})),
		{ value: "unassigned", label: "Unassigned" },
		{ value: "everyone", label: "Everyone" },
	];

	// How much of what is now out of sight is doing something. Only the three
	// that change which rows the list holds count: density is a look, and sort
	// is an order. Empty projects counts here even though the Repo picker is
	// its other door, because this is the number that explains a short list.
	const advancedChanged =
		(filter.prs === "default" ? 0 : 1) +
		(filter.autoCreated === "hide" ? 0 : 1) +
		(filter.emptyProjects === "show" ? 0 : 1);

	return createPortal(
		<>
			<div className={BACKDROP} onClick={onClose} />
			<div className={FILTER_POPOVER} style={{ left, top, width }}>
				{/* The list is an inbox whichever of these is picked: its rows
				    band by what they want from you and when they last moved. This
				    is what sits above those bands — nothing, one band per project,
				    or the status lanes, which stand in for them. It was two rows
				    ("Sections" and "Group by") answering that as six combinations,
				    two of which nobody needed: a list with no headings at all, and
				    the status lanes nested under every project, which split the one
				    "Needs input" heading status is for into one per project. */}
				<FilterRow
					label="Group by"
					value={filter.groupBy}
					options={[
						// "Activity", not "Nothing": this is the inbox's own bands
						// (Needs action / Recent / Yesterday / Earlier / Done) with
						// nothing above them, so a list with five headings in it must
						// not claim to have none. The stored value stays "none".
						{ value: "none", label: "Activity" },
						{ value: "repo", label: "Project" },
						{ value: "status", label: "Status" },
					]}
					onSelect={(v) => onChange({ groupBy: v as GroupBy })}
				/>
				{/* The projects, and under them the one setting about the set of
				    them rather than about which one you are in. It is in two
				    places on purpose: here, under the list of projects it is
				    about, and in Advanced with the other things that decide what
				    the list holds. Whichever you open, it reads and writes the
				    same setting. */}
				<FilterRow
					label="Repo"
					value={filter.repo}
					options={repoOptions}
					onSelect={(v) => onChange({ repo: v })}
					footer={
						<Menu.CheckboxItem
							checked={filter.emptyProjects === "hide"}
							onCheckedChange={(hide) =>
								onChange({ emptyProjects: hide ? "hide" : "show" })
							}
						>
							{/* "when empty", not "empty projects": the list above it has
							    just named the projects, so the row only has to say what
							    happens to one. */}
							<span className="grow truncate">Hide when empty</span>
							<SwitchIndicator on={filter.emptyProjects === "hide"} />
						</Menu.CheckboxItem>
					}
				/>
				<FilterRow
					label="Person"
					value={filter.person}
					options={personOptions}
					onSelect={(v) => onChange({ person: v })}
				/>
				{/* The settings you set once and forget, one level in: what the
				    list is made of and who it is for stays on the panel, and the
				    rest is here.

				    It says how many of them are off their default, because a
				    setting that hides rows is exactly the one you want to find
				    again when the list looks short, and a closed menu cannot
				    show you that it is the reason. Sort and density change how
				    the list reads rather than what is in it, so neither is part
				    of that count. */}
				<Menu.Root>
					<Menu.Trigger className={cn(FILTER_ROW, "mt-1")}>
						<span className="shrink-0 text-dim">Advanced</span>
						<span className="ml-auto flex min-w-0 items-center gap-2 text-fg">
							{advancedChanged > 0 && (
								<span className="truncate text-dim">
									{advancedChanged} changed
								</span>
							)}
							<IconChevronRight
								size={16}
								className="-mr-0.5 shrink-0 text-faint"
							/>
						</span>
					</Menu.Trigger>
					<Menu.Popup align="end" sideOffset={6}>
						<FilterSubmenu
							label="Sort by"
							value={filter.sort}
							options={[
								{ value: "updated", label: "Updated" },
								{ value: "created", label: "Created" },
							]}
							onSelect={(v) => onChange({ sort: v as SortBy })}
						/>
						{/* Session-less PR rows in the project sections (the dissolved
						    PR band): whose PRs surface. */}
						<FilterSubmenu
							label="Pull requests"
							value={filter.prs}
							options={[
								{ value: "default", label: "Mine + requested" },
								{ value: "all", label: "Everyone's" },
								{ value: "none", label: "Hidden" },
							]}
							onSelect={(v) => onChange({ prs: v as PrsFilter })}
						/>
						{/* Workspaces an agent started for itself. They sit in the
						    ordinary sections wearing a robot, so this is how you get a
						    day's worth of them out of the way. A row you have open,
						    one you pinned, and one asking for your review stay
						    whatever this says.

						    A setting with only an on and an off is a row you flip, not
						    a question with a submenu behind it: "Shown" and "Hidden"
						    one level further in is a menu to read and two presses to
						    answer what one press answers here. It wears a switch
						    rather than a tick because it is a setting, not one option
						    picked out of a list: a switch says on and off in its
						    shape, where a tick can only say "this one" by being
						    there and "not this one" by being absent. Named for what
						    turning it on does, and it stays open on a press, the way
						    every checkable menu row in the app does. */}
						<Menu.CheckboxItem
							checked={filter.autoCreated === "show"}
							onCheckedChange={(shown) =>
								onChange({ autoCreated: shown ? "show" : "hide" })
							}
						>
							<span className="grow truncate">Show auto created</span>
							<SwitchIndicator on={filter.autoCreated === "show"} />
						</Menu.CheckboxItem>
						{/* A registered project with no work in it still draws a band,
						    so a repo you just connected has somewhere to start from,
						    and on an instance with more projects than you work in that
						    is a screen of empty headings. Scoping the list to one
						    project shows that project either way, empty or not.

						    Its other door is the Repo picker, under the projects it is
						    about. Here it sits with the rest of what decides which rows
						    the list holds, and counts towards the "N changed" above. */}
						<Menu.CheckboxItem
							checked={filter.emptyProjects === "hide"}
							onCheckedChange={(hide) =>
								onChange({ emptyProjects: hide ? "hide" : "show" })
							}
						>
							<span className="grow truncate">Hide empty projects</span>
							<SwitchIndicator on={filter.emptyProjects === "hide"} />
						</Menu.CheckboxItem>
						{/* Behind a rule, because it is the odd one here: everything
						    above decides which rows the list holds, and this only
						    decides how tightly they are drawn. It is also the only
						    row here that is not part of the filter at all: it writes
						    a stored preference the Appearance settings share.

						    Desktop only, because that is the whole of what the
						    preference does: a phone row is a tap target and keeps its
						    own padding at either setting (see SIDEBAR_DENSITY_VARS),
						    so offering the control there would be a switch that
						    changes nothing. The rule goes inside that check, so a
						    phone does not end the menu on a line with nothing under
						    it. */}
						{!isPhone && (
							<>
								<Menu.Separator />
								<FilterSubmenu
									label="Density"
									value={density}
									options={DENSITY_OPTIONS.map(({ value, label, Icon }) => ({
										value,
										label,
										icon: <Icon size={16} />,
									}))}
									onSelect={(v) => setSidebarDensity(v as SidebarDensity)}
								/>
							</>
						)}
					</Menu.Popup>
				</Menu.Root>
				<button
					type="button"
					className={cn(FILTER_ROW, "mt-1 text-fg")}
					onClick={onCustomize}
				>
					<IconSliders size={20} className="shrink-0 text-dim" />
					<span className="truncate">Customize sidebar</span>
				</button>
			</div>
		</>,
		document.body,
	);
}

// The removable "active repo filter" chip. Rendered in three variants:
// "inline" (in the header, behind the title), "row" (its own line under the
// header) and "probe" (an off-layout copy used only to measure natural width —
// non-interactive and hidden from a11y).
export const RepoFilterChip = React.forwardRef<
	HTMLSpanElement,
	{
		repo: string;
		repos?: string[];
		onClear?: () => void;
		onSelect?: (repo: string) => void;
		variant: "inline" | "row" | "probe";
	}
>(function RepoFilterChip({ repo, repos = [], onClear, onSelect, variant }, ref) {
	const probe = variant === "probe";

	// One step down from the tile's 18px default, so the pill stays the height
	// of the text beside it.
	const body = (
		<>
			<RepoTile name={repo} size={17} />
			<span className="min-w-0 truncate text-dim">{repoLabel(repo)}</span>
		</>
	);
	const bodyClass =
		"inline-flex min-w-0 items-center gap-[7px] rounded-full px-[3px] py-0.5 text-label leading-[1.15] hover:bg-hover data-[popup-open]:bg-hover";

	return (
		<span
			ref={ref}
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-px rounded-full border border-line bg-panel px-1 py-[3px] text-label leading-[1.15]",
				variant === "inline" && "shrink-0 max-w-none",
				variant === "probe" && "pointer-events-none absolute left-[-9999px] top-0 max-w-none invisible",
			)}
			aria-hidden={probe || undefined}
		>
			{/* Body opens the repo menu; the × clears the filter. The probe is
			    measured, never pressed, so it renders the same box without one. */}
			{probe ? (
				<span className={bodyClass}>{body}</span>
			) : (
				<Menu.Root>
					<Menu.Trigger className={bodyClass} title="Switch repo">
						{body}
					</Menu.Trigger>
					<Menu.Popup align="start" sideOffset={5}>
						<Menu.RadioGroup
							value={repo}
							onValueChange={(next) => onSelect?.(String(next))}
						>
							<Menu.RadioItem
								value="all"
								closeOnClick
								className="justify-between gap-3"
							>
								<span className="flex min-w-0 items-center gap-2">
									<span className={GLYPH_SLOT} />
									<span className="min-w-0 truncate">All repos</span>
								</span>
								<Menu.Check on={repo === "all"} />
							</Menu.RadioItem>
							{repos.map((name) => (
								<Menu.RadioItem
									key={name}
									value={name}
									closeOnClick
									className="justify-between gap-3"
								>
									<span className="flex min-w-0 items-center gap-2">
										<span className={GLYPH_SLOT}>
											<RepoTile name={name} size={16} />
										</span>
										<span className="min-w-0 truncate">{repoLabel(name)}</span>
									</span>
									<Menu.Check on={name === repo} />
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Root>
			)}
			<button
				type="button"
				className="inline-flex size-[19px] shrink-0 items-center justify-center rounded-full text-item-title leading-none text-faint hover:bg-hover hover:text-fg"
				title="Clear repo filter"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : onClear}
			>
				×
			</button>
		</span>
	);
});
