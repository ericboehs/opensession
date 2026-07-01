import React, { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser, TEAM } from "./UserPicker";
import { getPins, onPinsChanged } from "../lib/pins";
import { getRecents, onRecentsChanged } from "../lib/recents";

const RECENTLY_OPENED_COUNT = 6;

const AUTOMATION_COLOR = "#d29922";

// A palette for per-person group dots. The color is picked deterministically
// from the (lowercased) person name so each teammate keeps a stable color.
const PERSON_COLORS = [
	"#e8836b",
	"#6ba5e8",
	"#8ed99c",
	"#e8c46b",
	"#c06be8",
	"#6be8d2",
	"#e86b9c",
	"#a3b86b",
];

function personColor(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
}

// Only recognized people get their own "people" section. Sessions whose
// `startedBy` is something other than a real teammate — test labels
// ("proof-test", "image-test"), action/integration names ("Slack",
// "Make Michiel editor (action)"), or empty — are hidden rather than shown as
// stray sections. "Michael" (the assistant) counts as a person here.
const KNOWN_PEOPLE = new Set([...TEAM, "Michael"].map((n) => n.toLowerCase()));

export type NavView =
	| "sessions"
	| "reviews"
	| "automations"
	| "goals"
	| "actions"
	| "wiki"
	| "connections";

interface Props {
	sessions: UnifiedSession[];
	selectedId: string | null;
	activeView: NavView;
	onNavigate: (view: NavView) => void;
	onSelect: (session: UnifiedSession) => void;
	onNewSession: () => void;
	/** Start a new project (folder-plus icon) — opens the new-session palette. */
	onNewProject: () => void;
	onOpenArchived: () => void;
	onArchive: (session: UnifiedSession) => void;
	/** Rename a session (double-click its title); empty title resets it. */
	onRename: (session: UnifiedSession, title: string) => void;
}

const NAV_ITEMS: Array<{
	view: NavView;
	label: string;
	icon: React.ReactNode;
}> = [
	{
		view: "sessions",
		label: "Sessions",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path d="M2.5 4h11M2.5 8h11M2.5 12h7" strokeLinecap="round" />
			</svg>
		),
	},
	{
		view: "reviews",
		label: "Reviews",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="4" cy="4" r="1.6" />
				<circle cx="4" cy="12" r="1.6" />
				<circle cx="12" cy="12" r="1.6" />
				<path
					d="M4 5.6v4.8M12 10.4V8a2.4 2.4 0 0 0-2.4-2.4H7.2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				<path
					d="M8.8 4.2L7.2 5.6l1.6 1.4"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		view: "automations",
		label: "Automations",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		view: "goals",
		label: "Goals",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="8" cy="8" r="6" />
				<circle cx="8" cy="8" r="3" />
				<circle cx="8" cy="8" r="0.6" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		view: "actions",
		label: "Actions",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-.5-5.5z"
					strokeLinejoin="round"
				/>
			</svg>
		),
	},
	{
		view: "wiki",
		label: "Notes",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M3 2.5h7a2 2 0 0 1 2 2v9l-3-1.8-3 1.8-3-1.8V2.5z"
					strokeLinejoin="round"
					transform="translate(0.5,0)"
				/>
			</svg>
		),
	},
	{
		view: "connections",
		label: "Connections",
		icon: (
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<circle cx="4.5" cy="8" r="2" />
				<circle cx="11.5" cy="4" r="2" />
				<circle cx="11.5" cy="12" r="2" />
				<path d="M6.3 7.1l3.4-2.2M6.3 8.9l3.4 2.2" strokeLinecap="round" />
			</svg>
		),
	},
];

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — My sessions (split by status), Recently opened, Pinned
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation ("projects")
type GroupBand = "personal" | "people" | "automations";

// The bands below the personal one get a text header ("People" / "Projects").
function bandLabel(band: GroupBand): string | null {
	if (band === "people") return "People";
	if (band === "automations") return "Projects";
	return null;
}

interface Group {
	key: string;
	label: string;
	dotColor: string | null;
	band: GroupBand;
	items: UnifiedSession[];
}

// "My sessions" is split, Conductor-style, into status buckets. Order + labels +
// dot color are defined here; a session is bucketed by the first rule it matches.
type MineStatus = "needsinput" | "merged" | "done" | "review" | "inprogress";

const MINE_STATUS_META: Array<{
	key: MineStatus;
	label: string;
	dotColor: string;
}> = [
	{ key: "needsinput", label: "Needs input", dotColor: "var(--accent)" },
	{ key: "merged", label: "Merged", dotColor: "var(--purple)" },
	{ key: "done", label: "Done", dotColor: "var(--text-faint)" },
	{ key: "review", label: "Review", dotColor: "var(--green)" },
	{ key: "inprogress", label: "In progress", dotColor: "var(--yellow)" },
];

function mineStatus(s: UnifiedSession): MineStatus {
	// A blocked question needs a human right now — surface it above everything
	// else, even an open PR, so it never hides inside another bucket.
	if (s.waitingForInput) return "needsinput";
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "OPEN") return "review";
	if (s.isRunning) return "inprogress";
	return "done";
}

const EXPANDED_KEY = "michael-sidebar-expanded";

const DEFAULT_EXPANDED = [
	"recently",
	"pinned",
	"status:needsinput",
	"status:merged",
	"status:done",
	"status:review",
	"status:inprogress",
];

function readExpanded(): Set<string> {
	try {
		return new Set(
			JSON.parse(
				localStorage.getItem(EXPANDED_KEY) || JSON.stringify(DEFAULT_EXPANDED),
			),
		);
	} catch {
		return new Set(DEFAULT_EXPANDED);
	}
}

// ── Grouping / filtering controls (the filter popover) ─────────────────────
// The sidebar can be organized two ways ("Group by"), narrowed to a single repo
// ("Repo"), and ordered by recency of activity or creation ("Sort by"). The three
// choices persist together per browser.
type GroupBy = "status" | "repo";
type SortBy = "updated" | "created";
const DEFAULT_PROJECT = "tella-fusion";
const FILTER_KEY = "michael-sidebar-filter";

interface FilterState {
	groupBy: GroupBy;
	repo: string; // a project id, or "all"
	sort: SortBy;
}

function readFilter(): FilterState {
	try {
		const v = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
		return {
			groupBy: v.groupBy === "repo" ? "repo" : "status",
			repo: typeof v.repo === "string" ? v.repo : "all",
			sort: v.sort === "created" ? "created" : "updated",
		};
	} catch {
		return { groupBy: "status", repo: "all", sort: "updated" };
	}
}

function sessionRepo(s: UnifiedSession): string {
	return s.project || DEFAULT_PROJECT;
}

// Stable per-repo swatch color, reusing the person palette hashing so a repo
// keeps the same color across renders.
function repoColor(key: string): string {
	return personColor(key);
}

export function Sidebar({
	sessions,
	selectedId,
	activeView,
	onNavigate,
	onSelect,
	onNewSession,
	onNewProject,
	onOpenArchived,
	onArchive,
	onRename,
}: Props) {
	const [search, setSearch] = useState("");
	// Groups are collapsed by default; the expanded set persists per browser
	const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
	const [pins, setPins] = useState<string[]>(getPins);
	const [recents, setRecents] = useState<string[]>(getRecents);
	const currentUser = useCurrentUser();

	// Filter popover (group by / repo / sort) — its choices persist together.
	const [filter, setFilterState] = useState<FilterState>(readFilter);
	const [filterOpen, setFilterOpen] = useState(false);
	const filterBtnRef = useRef<HTMLButtonElement>(null);
	function setFilter(patch: Partial<FilterState>) {
		setFilterState((prev) => {
			const next = { ...prev, ...patch };
			localStorage.setItem(FILTER_KEY, JSON.stringify(next));
			return next;
		});
	}

	useEffect(() => onPinsChanged(() => setPins(getPins())), []);
	useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);

	const archivedCount = useMemo(
		() => sessions.filter((s) => s.archived).length,
		[sessions],
	);

	// Distinct repos across the (non-archived) sessions, most-used first, for the
	// Repo filter dropdown. Built off every session (not the search-filtered set)
	// so the options don't churn while you type.
	const repos = useMemo(() => {
		const counts = new Map<string, number>();
		for (const s of sessions) {
			if (s.archived) continue;
			const p = sessionRepo(s);
			counts.set(p, (counts.get(p) || 0) + 1);
		}
		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([name]) => name);
	}, [sessions]);

	const filtered = useMemo(() => {
		let visible = sessions.filter((s) => !s.archived);
		if (filter.repo !== "all")
			visible = visible.filter((s) => sessionRepo(s) === filter.repo);
		if (!search) return visible;
		const q = search.toLowerCase();
		return visible.filter(
			(s) =>
				s.title.toLowerCase().includes(q) ||
				(s.branch || "").toLowerCase().includes(q) ||
				(s.startedBy || "").toLowerCase().includes(q) ||
				(s.automation || "").toLowerCase().includes(q),
		);
	}, [sessions, search, filter.repo]);

	// Sort order applied to every group's items: newest activity or newest
	// creation first. Groups read from this pre-sorted list so ordering is uniform.
	const sorted = useMemo(() => {
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		return [...filtered].sort(
			(a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
		);
	}, [filtered, filter.sort]);

	const groups = useMemo(() => {
		const out: Group[] = [];
		const user = currentUser.toLowerCase();
		const pinSet = new Set(pins);

		// "Group by: Repo" — a flat list of one group per repo, ordered most-used
		// first, ignoring the personal/people/automations split entirely.
		if (filter.groupBy === "repo") {
			const byRepo = new Map<string, UnifiedSession[]>();
			for (const s of sorted) {
				const p = sessionRepo(s);
				const list = byRepo.get(p) || [];
				list.push(s);
				byRepo.set(p, list);
			}
			const keys = Array.from(byRepo.keys()).sort(
				(a, b) => byRepo.get(b)!.length - byRepo.get(a)!.length || a.localeCompare(b),
			);
			for (const p of keys) {
				out.push({
					key: `repo:${p}`,
					label: p,
					dotColor: repoColor(p),
					band: "personal",
					items: byRepo.get(p)!,
				});
			}
			return out;
		}

		const pinned = sorted.filter((s) => pinSet.has(s.id));
		if (pinned.length > 0) {
			out.push({
				key: "pinned",
				label: "Pinned",
				dotColor: null,
				band: "personal",
				items: pinned,
			});
		}

		// "My sessions": sessions started by the current user (automations
		// excluded), split into status buckets (Merged / Done / Review / In
		// progress) and rendered above Recently opened.
		const mine = sorted.filter(
			(s) =>
				!s.automation &&
				!pinSet.has(s.id) &&
				s.startedBy &&
				s.startedBy.toLowerCase() === user,
		);
		if (mine.length > 0) {
			const byStatus = new Map<MineStatus, UnifiedSession[]>();
			for (const s of mine) {
				const st = mineStatus(s);
				const list = byStatus.get(st) || [];
				list.push(s);
				byStatus.set(st, list);
			}
			for (const meta of MINE_STATUS_META) {
				const items = byStatus.get(meta.key);
				if (!items || items.length === 0) continue;
				out.push({
					key: `status:${meta.key}`,
					label: meta.label,
					dotColor: meta.dotColor,
					band: "personal",
					items,
				});
			}
		}

		// "Recently opened": a quick-access shortcut to the sessions you last opened
		// (newest first). Hidden while searching; items still appear in their normal
		// groups above/below. Only the freshest few are shown.
		if (!search.trim()) {
			const byId = new Map(sorted.map((s) => [s.id, s] as const));
			const recentItems = recents
				.map((id) => byId.get(id))
				.filter((s): s is UnifiedSession => Boolean(s))
				.slice(0, RECENTLY_OPENED_COUNT);
			if (recentItems.length > 0) {
				out.push({
					key: "recently",
					label: "Recently opened",
					dotColor: null,
					band: "personal",
					items: recentItems,
				});
			}
		}

		// One group per other person: every non-automation session owned by
		// someone other than the current user, grouped by `startedBy`. The current
		// user's own sessions already live in "My sessions" above, so they're not
		// repeated here (no double-listing). Only recognized teammates get a
		// section — sessions with an unrecognized or empty `startedBy` are hidden
		// (see KNOWN_PEOPLE). Keyed by lowercased name to merge casing variants;
		// the first-seen spelling is used as the label.
		const byPerson = new Map<
			string,
			{ label: string; items: UnifiedSession[] }
		>();
		for (const s of sorted) {
			if (s.automation || pinSet.has(s.id) || !s.startedBy) continue;
			const key = s.startedBy.toLowerCase();
			if (key === user) continue; // already in "My sessions"
			if (!KNOWN_PEOPLE.has(key)) continue; // hide non-person owners
			const entry = byPerson.get(key) || { label: s.startedBy, items: [] };
			entry.items.push(s);
			byPerson.set(key, entry);
		}
		for (const key of Array.from(byPerson.keys()).sort()) {
			const { label, items } = byPerson.get(key)!;
			out.push({
				key: `person:${key}`,
				label,
				dotColor: personColor(key),
				band: "people",
				items,
			});
		}

		// Automations last, each in its own group (band "automations").
		const byAutomation = new Map<string, UnifiedSession[]>();
		for (const s of sorted) {
			if (!s.automation || pinSet.has(s.id)) continue;
			const list = byAutomation.get(s.automation) || [];
			list.push(s);
			byAutomation.set(s.automation, list);
		}
		for (const name of Array.from(byAutomation.keys()).sort()) {
			out.push({
				key: `auto:${name}`,
				label: name,
				dotColor: AUTOMATION_COLOR,
				band: "automations",
				items: byAutomation.get(name)!,
			});
		}

		return out;
	}, [sorted, currentUser, pins, recents, search, filter.groupBy]);

	// Repo groups are open by default (grouping by repo is itself the point), so we
	// track their *collapsed* state under a "collapsed:" key; every other group is
	// closed by default and tracked directly.
	const collapseKey = (key: string) =>
		key.startsWith("repo:") ? `collapsed:${key}` : key;

	function toggleGroup(key: string) {
		const stored = collapseKey(key);
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(stored)) next.delete(stored);
			else next.add(stored);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// While searching, show everything that matched.
	const isOpen = (key: string) => {
		if (search.trim().length > 0) return true;
		if (key.startsWith("repo:")) return !expanded.has(`collapsed:${key}`);
		return expanded.has(key);
	};

	// Distinct open PRs (deduped by URL) — shown as a badge on the Reviews tab.
	const openPrCount = useMemo(() => {
		const urls = new Set<string>();
		for (const s of sessions) {
			if (s.prUrl && s.prState === "OPEN" && !s.archived) urls.add(s.prUrl);
		}
		return urls.size;
	}, [sessions]);

	return (
		<div className="sidebar">
			<nav className="sidebar-nav">
				{NAV_ITEMS.map((item) => (
					<button
						key={item.view}
						className={`sidebar-nav-item ${activeView === item.view ? "active" : ""}`}
						onClick={() => onNavigate(item.view)}
					>
						<span className="sidebar-nav-icon">{item.icon}</span>
						{item.label}
						{item.view === "reviews" && openPrCount > 0 && (
							<span className="sidebar-nav-count">{openPrCount}</span>
						)}
					</button>
				))}
			</nav>

			<div className="sidebar-workspace">
				<div className="sidebar-workspace-head">
					<span className="sidebar-workspace-title">My sessions</span>
					<div className="sidebar-workspace-spacer" />
					<button
						ref={filterBtnRef}
						className={`sidebar-new-btn sidebar-filter-btn${
							filterOpen ? " active" : ""
						}${
							filter.groupBy !== "status" || filter.repo !== "all"
								? " has-filter"
								: ""
						}`}
						onClick={() => setFilterOpen((o) => !o)}
						title="Group, filter & sort"
					>
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
							<path
								d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</button>
					<button
						className="sidebar-new-btn"
						onClick={onNewProject}
						title="New project"
					>
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
							<path
								d="M1.75 4.25c0-.55.45-1 1-1h3.1c.32 0 .62.15.8.4l.7.95h5.1c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.25z"
								stroke="currentColor"
								strokeWidth="1.3"
								strokeLinejoin="round"
							/>
							<path
								d="M8 8v3.2M6.4 9.6h3.2"
								stroke="currentColor"
								strokeWidth="1.3"
								strokeLinecap="round"
							/>
						</svg>
					</button>
					<button
						className="sidebar-new-btn"
						onClick={onNewSession}
						title="New session"
					>
						+
					</button>
				</div>

				{filter.repo !== "all" && (
					<div className="sidebar-repo-row">
						<span className="sidebar-repo-chip">
							<RepoTile name={filter.repo} />
							<span className="sidebar-repo-chip-name">{filter.repo}</span>
							<button
								className="sidebar-repo-chip-x"
								title="Clear repo filter"
								onClick={() => setFilter({ repo: "all" })}
							>
								×
							</button>
						</span>
					</div>
				)}

				<div className="sidebar-search-wrap">
					<svg
						className="sidebar-search-icon"
						width="13"
						height="13"
						viewBox="0 0 16 16"
						fill="none"
					>
						<circle
							cx="7"
							cy="7"
							r="5"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
						<path
							d="M14 14L10.7 10.7"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
					<input
						className="sidebar-search"
						type="text"
						placeholder="Search sessions"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
			</div>

			{filterOpen && (
				<FilterPopover
					anchor={filterBtnRef.current}
					filter={filter}
					repos={repos}
					onChange={setFilter}
					onClose={() => setFilterOpen(false)}
				/>
			)}

			<div className="sidebar-list">
				{groups.length === 0 && (
					<div className="sidebar-empty">No sessions</div>
				)}
				{groups.map((group, i) => {
					const bandChanged = i > 0 && group.band !== groups[i - 1].band;
					const label = bandChanged ? bandLabel(group.band) : null;
					const open = isOpen(group.key);
					return (
					<div
						key={group.key}
						className={`sidebar-group${
							bandChanged ? " sidebar-group--band-start" : ""
						}`}
					>
						{label && <div className="sidebar-band-label">{label}</div>}
						<button
							className="sidebar-group-header"
							onClick={() => toggleGroup(group.key)}
						>
							{group.dotColor && (
								<span
									className="sidebar-group-dot"
									style={{ backgroundColor: group.dotColor }}
								/>
							)}
							<span className="sidebar-group-name">{group.label}</span>
							<span className="sidebar-group-count">{group.items.length}</span>
							<span className="sidebar-group-chevron">
								{open ? "▾" : "▸"}
							</span>
						</button>

						{/* When collapsed, still surface the actively selected session so
						    it never disappears behind a closed group header. */}
						{group.items
							.filter((s) => open || s.id === selectedId)
							.map((s) => (
								<SidebarItem
									key={s.id}
									session={s}
									selected={s.id === selectedId}
									onClick={() => onSelect(s)}
									onArchive={() => onArchive(s)}
									onRename={(title) => onRename(s, title)}
								/>
							))}
					</div>
					);
				})}

				{archivedCount > 0 && (
					<button className="sidebar-archived-link" onClick={onOpenArchived}>
						Archived ({archivedCount}) →
					</button>
				)}
			</div>
		</div>
	);
}

// ── Filter popover ─────────────────────────────────────────────────────────
// A small floating panel (anchored under the filter button) with three controls:
// Group by (Status / Repo), Repo (All repos + one per repo), and Sort by
// (Updated / Created). Rendered in a portal so it can overflow the narrow sidebar.

interface SelectOption {
	value: string;
	label: string;
	icon?: React.ReactNode;
}

function FilterPopover({
	anchor,
	filter,
	repos,
	onChange,
	onClose,
}: {
	anchor: HTMLElement | null;
	filter: FilterState;
	repos: string[];
	onChange: (patch: Partial<FilterState>) => void;
	onClose: () => void;
}) {
	if (!anchor) return null;
	const r = anchor.getBoundingClientRect();
	const width = 290;
	const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
	const top = r.bottom + 6;

	const repoOptions: SelectOption[] = [
		{ value: "all", label: "All repos" },
		...repos.map((name) => ({
			value: name,
			label: name,
			icon: <RepoTile name={name} />,
		})),
	];

	return createPortal(
		<>
			<div className="menu-backdrop" onClick={onClose} />
			<div className="filter-popover" style={{ left, top, width }}>
				<div className="filter-row">
					<span className="filter-row-label">Group by</span>
					<MiniSelect
						value={filter.groupBy}
						options={[
							{ value: "status", label: "Status" },
							{ value: "repo", label: "Repo" },
						]}
						onSelect={(v) => onChange({ groupBy: v as GroupBy })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Repo</span>
					<MiniSelect
						value={filter.repo}
						options={repoOptions}
						onSelect={(v) => onChange({ repo: v })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Sort by</span>
					<MiniSelect
						value={filter.sort}
						options={[
							{ value: "updated", label: "Updated" },
							{ value: "created", label: "Created" },
						]}
						onSelect={(v) => onChange({ sort: v as SortBy })}
					/>
				</div>
			</div>
		</>,
		document.body,
	);
}

// A styled dropdown used by the filter popover. Its menu is portaled so it can
// escape both the popover and the sidebar; a transparent backdrop closes it.
function MiniSelect({
	value,
	options,
	onSelect,
}: {
	value: string;
	options: SelectOption[];
	onSelect: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);
	const current = options.find((o) => o.value === value);
	const r = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null;

	let menu: React.ReactNode = null;
	if (open && r) {
		const menuW = Math.max(r.width, 150);
		const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
		menu = createPortal(
			<>
				<div
					className="menu-backdrop menu-backdrop--nested"
					onClick={() => setOpen(false)}
				/>
				<div
					className="mini-select-menu"
					style={{ left, top: r.bottom + 4, minWidth: menuW }}
				>
					{options.map((o) => (
						<button
							key={o.value}
							className={`mini-select-item${o.value === value ? " selected" : ""}`}
							onClick={() => {
								onSelect(o.value);
								setOpen(false);
							}}
						>
							{o.icon}
							<span className="mini-select-item-text">{o.label}</span>
							{o.value === value && (
								<svg
									className="mini-select-check"
									width="13"
									height="13"
									viewBox="0 0 16 16"
									fill="none"
								>
									<path
										d="M3.5 8.5l3 3 6-7"
										stroke="currentColor"
										strokeWidth="1.6"
										strokeLinecap="round"
										strokeLinejoin="round"
									/>
								</svg>
							)}
						</button>
					))}
				</div>
			</>,
			document.body,
		);
	}

	return (
		<div className="mini-select-wrap">
			<button
				ref={btnRef}
				className="mini-select"
				onClick={() => setOpen((o) => !o)}
			>
				<span className="mini-select-value">
					{current?.icon}
					<span className="mini-select-text">{current?.label ?? value}</span>
				</span>
				<svg
					className="mini-select-caret"
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
				>
					<path
						d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{menu}
		</div>
	);
}

// A tiny colored letter-tile standing in for a repo's icon in the Repo dropdown.
function RepoTile({ name }: { name: string }) {
	return (
		<span className="repo-tile" style={{ background: repoColor(name) }}>
			{(name[0] || "?").toUpperCase()}
		</span>
	);
}

function SidebarItem({
	session,
	selected,
	onClick,
	onArchive,
	onRename,
}: {
	session: UnifiedSession;
	selected: boolean;
	onClick: () => void;
	onArchive: () => void;
	onRename: (title: string) => void;
}) {
	const running = session.isRunning;
	const waiting = !!session.waitingForInput;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	// Hover card: after a short dwell, anchor a detail popover to this row's right
	// edge. Suppressed while renaming (the input owns the interaction).
	const btnRef = useRef<HTMLButtonElement>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);

	function openHover() {
		if (editing) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = setTimeout(() => {
			const el = btnRef.current;
			if (el) setAnchor(el.getBoundingClientRect());
		}, 380);
	}
	function closeHover() {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
		setAnchor(null);
	}
	useEffect(
		() => () => {
			if (hoverTimer.current) clearTimeout(hoverTimer.current);
		},
		[],
	);

	function commitRename() {
		onRename(draft.trim());
		setEditing(false);
	}

	const metaParts: React.ReactNode[] = [];
	if (session.startedBy && !session.automation) {
		metaParts.push(<span key="u">{session.startedBy}</span>);
	}
	metaParts.push(<span key="t">{relativeTime(session.lastActivity)}</span>);
	if (session.prUrl) {
		metaParts.push(
			<span
				key="pr"
				className={
					session.prState === "MERGED"
						? "sidebar-meta-merged"
						: session.prState === "CLOSED"
							? "sidebar-meta-closed"
							: "sidebar-meta-pr"
				}
			>
				{session.prState === "MERGED"
					? "merged"
					: session.prState === "CLOSED"
						? "closed"
						: "PR open"}
			</span>,
		);
	}
	if (session.linearIssue) {
		metaParts.push(
			<span key="lin" className="sidebar-meta-linear">
				{session.linearIssue.identifier}
			</span>,
		);
	}

	return (
		<>
		<button
			ref={btnRef}
			className={`sidebar-item ${selected ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""}`}
			onClick={onClick}
			onMouseEnter={openHover}
			onMouseLeave={closeHover}
			onMouseDown={closeHover}
		>
			<div className="sidebar-item-top">
				{(waiting || running) && (
					<span
						className={`sidebar-item-status ${
							waiting
								? "sidebar-status-waiting"
								: "sidebar-status-running"
						}`}
					/>
				)}
				{editing ? (
					<input
						className="sidebar-item-rename"
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={commitRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							else if (e.key === "Escape") setEditing(false);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						className="sidebar-item-title"
						onDoubleClick={(e) => {
							e.stopPropagation();
							setDraft(session.title);
							setEditing(true);
						}}
					>
						{session.title}
					</span>
				)}
			</div>
			<div className="sidebar-item-meta">
				{metaParts.map((part, i) => (
					<React.Fragment key={i}>
						{i > 0 && <span className="sidebar-meta-sep">·</span>}
						{part}
					</React.Fragment>
				))}
			</div>
			<span
				className="sidebar-item-x"
				role="button"
				aria-label="Archive session"
				title="Archive session"
				onClick={(e) => {
					e.stopPropagation();
					onArchive();
				}}
			>
				×
			</span>
		</button>
		{anchor && <SessionHoverCard session={session} anchor={anchor} />}
		</>
	);
}

const CARD_W = 300;

// A detail popover shown after dwelling on a sidebar row. Content is
// state-dependent: the prominent status line and the rows that render depend on
// whether the session is waiting/running/merged/etc. and which of its optional
// facets (PR, Linear issue, goal, loop, extra repos) are populated. Everything
// comes off the already-loaded UnifiedSession — the card fetches nothing.
function SessionHoverCard({
	session: s,
	anchor,
}: {
	session: UnifiedSession;
	anchor: DOMRect;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
		left: anchor.right + 8,
		top: anchor.top,
	}));

	// Clamp into the viewport once we know the rendered height. Prefer the right
	// of the row; flip to the left if it would overflow the right edge.
	useEffect(() => {
		const el = cardRef.current;
		const h = el ? el.offsetHeight : 200;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		let left = anchor.right + 8;
		if (left + CARD_W > vw - 8) left = anchor.left - CARD_W - 8;
		left = Math.max(8, left);
		const top = Math.min(Math.max(8, anchor.top), vh - h - 8);
		setPos({ left, top });
	}, [anchor]);

	const state = hoverState(s);
	const rows: Array<[string, React.ReactNode]> = [];

	const owner = s.automation || s.startedBy;
	if (owner) rows.push([s.automation ? "Automation" : "Started by", owner]);
	if (s.model) rows.push(["Model", s.model]);
	if (s.mode) rows.push(["Mode", s.mode]);

	const repoLabel = s.project || "tella-fusion";
	const extra = s.attachedRepos?.length || 0;
	rows.push(["Repo", extra ? `${repoLabel} +${extra} more` : repoLabel]);
	if (s.branch)
		rows.push([
			"Branch",
			<span className="hovercard-mono">{s.branch}</span>,
		]);

	if (s.linearIssue)
		rows.push([
			"Linear",
			<span>
				<span className="hovercard-mono">{s.linearIssue.identifier}</span>{" "}
				{s.linearIssue.title}
			</span>,
		]);
	if (s.goal) rows.push(["Goal", "Autonomous goal session"]);
	if (s.loop)
		rows.push(["Loop", `Every ${s.loop.intervalMinutes} min`]);

	rows.push(["Last active", relativeTime(s.lastActivity)]);
	rows.push(["Created", relativeTime(s.createdAt)]);

	const card = (
		<div
			ref={cardRef}
			className="sidebar-hovercard"
			style={{ left: pos.left, top: pos.top, width: CARD_W }}
		>
			<div className="hovercard-head">
				<span
					className={`sidebar-item-status hovercard-dot ${state.dotClass}`}
				/>
				<span className="hovercard-branch">
					{s.branch || s.title}
				</span>
				{s.prAdditions != null && s.prDeletions != null && (
					<span className="hovercard-diff">
						<span className="hovercard-add">
							+{compactNum(s.prAdditions)}
						</span>{" "}
						<span className="hovercard-del">
							-{compactNum(s.prDeletions)}
						</span>
					</span>
				)}
			</div>

			<div className="hovercard-title">{s.title}</div>

			<div className={`hovercard-state hovercard-state-${state.tone}`}>
				{state.label}
			</div>

			{s.waitingForInput && (
				<div className="hovercard-callout">
					Blocked on a question — open the session to answer.
				</div>
			)}
			{!s.waitingForInput && (s.queuedCount ?? 0) > 0 && (
				<div className="hovercard-callout">
					{s.queuedCount} prompt{s.queuedCount === 1 ? "" : "s"} queued.
				</div>
			)}

			<div className="hovercard-rows">
				{rows.map(([label, value], i) => (
					<div className="hovercard-row" key={i}>
						<span className="hovercard-label">{label}</span>
						<span className="hovercard-value">{value}</span>
					</div>
				))}
			</div>

			{s.prUrl && (
				<div className="hovercard-pr">
					<span className="hovercard-mono">
						{s.prNumber ? `#${s.prNumber}` : "PR"}
					</span>
					<span className={`hovercard-pr-state hovercard-pr-${prTone(s)}`}>
						{prStateLabel(s)}
					</span>
					{s.prReviewDecision && (
						<span className="hovercard-pr-review">
							{prettyReview(s.prReviewDecision)}
						</span>
					)}
					{s.prChecks && s.prChecks.total > 0 && (
						<span className="hovercard-checks">
							{s.prChecks.failed > 0
								? `${s.prChecks.failed} failing`
								: s.prChecks.pending > 0
									? `${s.prChecks.pending} pending`
									: "checks pass"}
						</span>
					)}
				</div>
			)}
		</div>
	);

	return createPortal(card, document.body);
}

// The single prominent status line + its dot/tone. Ordering mirrors how a person
// triages: a blocked question first, then live activity, then PR/lifecycle.
function hoverState(s: UnifiedSession): {
	label: string;
	tone: "accent" | "green" | "purple" | "yellow" | "dim";
	dotClass: string;
} {
	if (s.waitingForInput)
		return {
			label: "Waiting for your input",
			tone: "accent",
			dotClass: "sidebar-status-waiting",
		};
	if (s.isRunning)
		return {
			label: "Running",
			tone: "green",
			dotClass: "sidebar-status-running",
		};
	if (s.prState === "MERGED")
		return { label: "Merged", tone: "purple", dotClass: "hovercard-dot-purple" };
	if (s.prState === "CLOSED")
		return { label: "PR closed", tone: "dim", dotClass: "hovercard-dot-red" };
	if (s.prState === "OPEN")
		return {
			label: s.prIsDraft ? "Draft PR — in review" : "In review",
			tone: "green",
			dotClass: "hovercard-dot-green",
		};
	return { label: "Idle", tone: "dim", dotClass: "hovercard-dot-dim" };
}

function prStateLabel(s: UnifiedSession): string {
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "CLOSED") return "closed";
	return s.prIsDraft ? "draft" : "open";
}
function prTone(s: UnifiedSession): string {
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "CLOSED") return "closed";
	return "open";
}
function prettyReview(d: string): string {
	if (d === "APPROVED") return "approved";
	if (d === "CHANGES_REQUESTED") return "changes requested";
	if (d === "REVIEW_REQUIRED") return "review required";
	return d.toLowerCase().replace(/_/g, " ");
}
function compactNum(n: number): string {
	if (n >= 10000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
