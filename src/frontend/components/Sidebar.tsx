import React, {
	useState,
	useMemo,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession, Project } from "../lib/types";
import { relativeTime } from "../lib/api";
import { useCurrentUser, TEAM } from "./UserPicker";
import { getPins, onPinsChanged, togglePin } from "../lib/pins";
import { getRecents, onRecentsChanged } from "../lib/recents";
import { getReads, isUnread, onReadsChanged } from "../lib/reads";
import { shortTime } from "../lib/time";
import { colorHex, TAB_COLORS } from "../lib/tab-colors";
import { IconChevronDown } from "./icons";
import { Tooltip } from "../ui/tooltip";

const AUTOMATION_COLOR = "#d29922";

// Long-press (touch) tuning for the mobile action sheet.
const LONG_PRESS_MS = 450; // hold before the sheet opens
const LONG_PRESS_SLOP = 10; // px of finger travel that cancels it (a scroll)

// Inline styles for the right-click menus. Kept inline (not in a CSS file)
// because component-imported CSS isn't linked into the served bundle — only
// global.css is — so a separate stylesheet silently doesn't apply.
const CTX_MENU_STYLE: React.CSSProperties = {
	position: "fixed",
	zIndex: 3000,
	minWidth: 180,
	maxWidth: 280,
	maxHeight: "60vh",
	overflowY: "auto",
	padding: 5,
	background: "var(--bg-panel)",
	border: "1px solid var(--border-strong)",
	borderRadius: 8,
	boxShadow: "0 6px 20px rgba(0, 0, 0, 0.4)",
	display: "flex",
	flexDirection: "column",
	gap: 1,
};
const CTX_ITEM_STYLE: React.CSSProperties = {
	display: "block",
	width: "100%",
	textAlign: "left",
	background: "none",
	border: "none",
	color: "var(--text)",
	fontSize: 13,
	padding: "6px 8px",
	borderRadius: 5,
	cursor: "pointer",
	whiteSpace: "nowrap",
	overflow: "hidden",
	textOverflow: "ellipsis",
};
const CTX_LABEL_STYLE: React.CSSProperties = {
	fontSize: 11,
	color: "var(--text-faint)",
	padding: "4px 8px 2px",
	textTransform: "uppercase",
	letterSpacing: "0.04em",
};
const CTX_SEP_STYLE: React.CSSProperties = {
	height: 1,
	background: "var(--border-strong)",
	margin: "4px 2px",
};

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
	| "security"
	| "goals"
	| "actions"
	| "wiki";

interface Props {
	sessions: UnifiedSession[];
	/** Project folders that group chats. */
	projects: Project[];
	/** Notes (id + title), to render pinned-note rows. */
	notes: Array<{ id: string; title: string }>;
	selectedId: string | null;
	/** The note currently open (highlights its pinned row), or null. */
	activeNoteId: string | null;
	activeView: NavView;
	onNavigate: (view: NavView) => void;
	onSelect: (session: UnifiedSession) => void;
	onNewSession: () => void;
	/** Open a project — its chats surface in the top tab strip. */
	onOpenProject: (id: string) => void;
	/** Rename a project folder. */
	onRenameProject: (id: string, name: string) => void;
	/** Delete a project folder (its chats become standalone). */
	onDeleteProject: (id: string) => void;
	/** Set a project's swatch color (null clears it). */
	onSetProjectColor: (id: string, color: string | null) => void;
	/** Move a chat into a project (or null to make it standalone). */
	onSetSessionProject: (sessionId: string, projectId: string | null) => void;
	/** Open a note (pinned-note row click). */
	onOpenNote: (id: string) => void;
	/** Open the ⌘K session-search palette (from the sidebar search field). */
	onOpenSearch: () => void;
	onOpenArchived: () => void;
	/** True while the archived view is open — highlights the Archived row. */
	archivedActive: boolean;
	/**
	 * Archive a session. `next` is the session that follows it in the sidebar's
	 * visible order (or the previous one for the last row) — the caller uses it
	 * to keep a live session open when the active one is archived.
	 */
	onArchive: (session: UnifiedSession, next: UnifiedSession | null) => void;
	/** Archive every chat in a workspace (the row's archive icon). */
	onArchiveWorkspace: (chats: UnifiedSession[]) => void;
	/** Rename a session (double-click its title); empty title resets it. */
	onRename: (session: UnifiedSession, title: string) => void;
	/** Who's viewing what right now (global presence), for the follow rail. */
	teamViewing?: Array<{ user: string; sessionId: string }>;
	/** Teammate currently being followed (navigation shadows them). */
	followUser?: string | null;
	/** Toggle following a teammate. */
	onToggleFollow?: (user: string) => void;
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
				width="18"
				height="18"
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
				width="18"
				height="18"
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
				width="18"
				height="18"
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
		view: "security",
		label: "Security",
		icon: (
			<svg
				width="18"
				height="18"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
			>
				<path
					d="M8 1.8l4.6 1.7v3.8c0 3-1.9 5.2-4.6 6.5-2.7-1.3-4.6-3.5-4.6-6.5V3.5L8 1.8z"
					strokeLinejoin="round"
				/>
				<path d="M6.1 8l1.3 1.3 2.5-2.6" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		view: "goals",
		label: "Goals",
		icon: (
			<svg
				width="18"
				height="18"
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
				width="18"
				height="18"
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
				width="18"
				height="18"
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
];

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — My sessions (split by status), Pinned
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation ("projects")
type GroupBand = "personal" | "people" | "automations";

// The bands below the personal one get a text header ("People" / "Projects").
function bandLabel(band: GroupBand): string | null {
	if (band === "people") return "People";
	if (band === "automations") return "Automations";
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
type MineStatus =
	| "needsinput"
	| "merged"
	| "pending"
	| "review"
	| "inprogress";

const MINE_STATUS_META: Array<{
	key: MineStatus;
	label: string;
	dotColor: string;
}> = [
	{ key: "needsinput", label: "Needs input", dotColor: "var(--accent)" },
	{ key: "inprogress", label: "In progress", dotColor: "var(--yellow)" },
	{ key: "review", label: "In review", dotColor: "var(--green)" },
	{ key: "merged", label: "Done", dotColor: "var(--purple)" },
	{ key: "pending", label: "Backlog", dotColor: "var(--text-faint)" },
];

function mineStatus(s: UnifiedSession): MineStatus {
	// A blocked question needs a human right now — surface it above everything
	// else, even an open PR, so it never hides inside another bucket.
	if (s.waitingForInput) return "needsinput";
	if (s.prState === "MERGED") return "merged";
	if (s.prState === "OPEN") return "review";
	if (s.isRunning) return "inprogress";
	// Everything else is idle-but-unfinished: no open/merged PR, not running,
	// not blocked. That's "Pending", not "Done" — finishing a session is an
	// explicit act (Archive), never inferred from a moment of inactivity.
	return "pending";
}

const EXPANDED_KEY = "michael-sidebar-expanded";

const DEFAULT_EXPANDED = [
	"recently",
	"pinned",
	"status:needsinput",
	"status:merged",
	"status:pending",
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
// The sidebar can be organized three ways ("Group by": Status, Repo, or Recently
// opened), narrowed to a single repo ("Repo") or a single person ("Person"), and
// ordered by recency of activity or creation ("Sort by"). The choices persist
// together per browser.
type GroupBy = "status" | "repo" | "recently";
type SortBy = "updated" | "created";
const DEFAULT_PROJECT = "tella-fusion";
const FILTER_KEY = "michael-sidebar-filter";

interface FilterState {
	groupBy: GroupBy;
	repo: string; // a repo id, or "all"
	person: string; // a lowercased person key, or "all"
	sort: SortBy;
}

function readFilter(): FilterState {
	try {
		const v = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
		return {
			groupBy:
				v.groupBy === "repo" || v.groupBy === "recently"
					? v.groupBy
					: "status",
			repo: typeof v.repo === "string" ? v.repo : "all",
			person: typeof v.person === "string" ? v.person : "all",
			sort: v.sort === "created" ? "created" : "updated",
		};
	} catch {
		return { groupBy: "status", repo: "all", person: "all", sort: "updated" };
	}
}

function sessionRepo(s: UnifiedSession): string {
	return s.repo || DEFAULT_PROJECT;
}

// Stable per-repo swatch color, reusing the person palette hashing so a repo
// keeps the same color across renders.
function repoColor(key: string): string {
	return personColor(key);
}

export function Sidebar({
	sessions,
	projects,
	notes,
	selectedId,
	activeNoteId,
	activeView,
	onNavigate,
	onSelect,
	onNewSession,
	onOpenProject,
	onRenameProject,
	onDeleteProject,
	onSetProjectColor,
	onSetSessionProject,
	onOpenNote,
	onOpenSearch,
	onOpenArchived,
	archivedActive,
	onArchive,
	onArchiveWorkspace,
	onRename,
	teamViewing = [],
	followUser = null,
	onToggleFollow,
}: Props) {
	const [search, setSearch] = useState("");
	// Groups are collapsed by default; the expanded set persists per browser
	const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
	const [pins, setPins] = useState<string[]>(getPins);
	const [recents, setRecents] = useState<string[]>(getRecents);
	// Per-session last-read marks, driving the unread dot. Kept in sync via the
	// same event the viewer fires when it marks a session read.
	const [reads, setReads] = useState(getReads);
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

	// The active repo-filter chip prefers to sit inline in the "My sessions"
	// header (right after the title); it drops to its own row only when the
	// sidebar is too narrow to fit it there. `repoInline` is decided by measuring
	// the header against an off-layout probe copy of the chip, so toggling it can't
	// feed back into the measurement (title/actions/probe widths don't depend on
	// where the real chip lands).
	const [repoInline, setRepoInline] = useState(true);
	const headRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLSpanElement>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const probeRef = useRef<HTMLSpanElement>(null);
	// Divider under the Sessions header, shown only once the list is scrolled off
	// the top — a scroll-shadow cue that there's content tucked under the header.
	const [listScrolled, setListScrolled] = useState(false);
	useLayoutEffect(() => {
		if (filter.repo === "all") return;
		const measure = () => {
			const head = headRef.current;
			const title = titleRef.current;
			const actions = actionsRef.current;
			const probe = probeRef.current;
			if (!head || !title || !actions || !probe) return;
			const GAP = 6; // .sidebar-workspace-head gap
			const MARGIN = 8; // breathing room so it never crowds the buttons
			const avail =
				head.clientWidth -
				title.offsetWidth -
				actions.offsetWidth -
				GAP * 2 -
				MARGIN;
			setRepoInline(probe.offsetWidth <= avail);
		};
		measure();
		const ro = new ResizeObserver(measure);
		if (headRef.current) ro.observe(headRef.current);
		return () => ro.disconnect();
		// filter.person changes the title text ("X's workspaces"), so re-measure.
	}, [filter.repo, filter.person]);

	useEffect(() => onPinsChanged(() => setPins(getPins())), []);
	useEffect(() => onRecentsChanged(() => setRecents(getRecents())), []);
	useEffect(() => onReadsChanged(() => setReads(getReads())), []);

	// Right-click menu on a Project header (rename / color / delete), and inline
	// rename (double-click the project name).
	const [projectMenu, setProjectMenu] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
	const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
	const [projectDraft, setProjectDraft] = useState("");
	function commitProjectRename() {
		if (editingProjectId) {
			const name = projectDraft.trim();
			if (name) onRenameProject(editingProjectId, name);
		}
		setEditingProjectId(null);
	}
	useEffect(() => {
		if (!projectMenu) return;
		const close = () => setProjectMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [projectMenu]);

	// The Archived row counts *my* archived sessions (Michiel's scope), and honors
	// the active repo filter — same lens as the archived page it opens.
	const archivedCount = useMemo(() => {
		const user = currentUser.toLowerCase();
		return sessions.filter(
			(s) =>
				s.archived &&
				!s.automation &&
				s.startedBy &&
				s.startedBy.toLowerCase() === user &&
				(filter.repo === "all" || sessionRepo(s) === filter.repo),
		).length;
	}, [sessions, currentUser, filter.repo]);

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

	// Distinct people who started sessions, most-active first, for the Person
	// filter dropdown. Only recognized teammates (see KNOWN_PEOPLE) are offered;
	// keyed by lowercased name to merge casing, with the first-seen spelling as
	// the display label. Built off every session so options don't churn on search.
	const people = useMemo(() => {
		const entries = new Map<string, { label: string; count: number }>();
		for (const s of sessions) {
			if (s.archived || s.automation || !s.startedBy) continue;
			const key = s.startedBy.toLowerCase();
			if (!KNOWN_PEOPLE.has(key)) continue;
			const e = entries.get(key) || { label: s.startedBy, count: 0 };
			e.count++;
			entries.set(key, e);
		}
		return Array.from(entries.entries())
			.sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
			.map(([key, { label }]) => ({ key, label }));
	}, [sessions]);

	// Every non-archived chat, narrowed by the repo/person filters and search.
	// Rows are built per-workspace below; a chat matching the filter surfaces its
	// whole workspace row.
	const filtered = useMemo(() => {
		let visible = sessions.filter((s) => !s.archived);
		if (filter.repo !== "all")
			visible = visible.filter((s) => sessionRepo(s) === filter.repo);
		if (filter.person !== "all")
			visible = visible.filter(
				(s) =>
					!s.automation &&
					!!s.startedBy &&
					s.startedBy.toLowerCase() === filter.person,
			);
		if (!search) return visible;
		const q = search.toLowerCase();
		return visible.filter(
			(s) =>
				s.title.toLowerCase().includes(q) ||
				(s.branch || "").toLowerCase().includes(q) ||
				(s.startedBy || "").toLowerCase().includes(q) ||
				(s.automation || "").toLowerCase().includes(q),
		);
	}, [sessions, search, filter.repo, filter.person]);

	// Sort order applied to every group's items: newest activity or newest
	// creation first. Groups read from this pre-sorted list so ordering is uniform.
	const sorted = useMemo(() => {
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		return [...filtered].sort(
			(a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
		);
	}, [filtered, filter.sort]);

	// ── Workspace rows ──────────────────────────────────────────────────────
	// The sidebar's main list is Workspaces (not individual chats): one row per
	// workspace, plus one implicit row per not-yet-wrapped standalone chat (the
	// pre-migration case — the data migration wraps those 1:1). A row's status
	// dot is derived from its most urgent chat; clicking opens the first chat.
	interface WsRow {
		/** Pin/menu key: `workspace:<id>` for real workspaces, the chat id solo. */
		key: string;
		/** Real workspace record, or null for an implicit single-chat row. */
		workspace: Project | null;
		name: string;
		chats: UnifiedSession[]; // createdAt asc — chats[0] is "the first chat"
		status: MineStatus;
		lastActivity: string;
		createdAt: string;
		unread: boolean;
		running: boolean;
		/** Lowercased owner (workspace creator, else the first chat's starter). */
		owner: string;
	}

	// Most-urgent-first for the row dot: a blocked question beats everything,
	// active review beats work-in-progress, merged/pending are quiet states.
	const STATUS_PRIORITY: MineStatus[] = [
		"needsinput",
		"review",
		"inprogress",
		"merged",
		"pending",
	];
	const STATUS_DOT: Record<MineStatus, string> = Object.fromEntries(
		MINE_STATUS_META.map((m) => [m.key, m.dotColor]),
	) as Record<MineStatus, string>;

	const wsRows = useMemo(() => {
		const rows: WsRow[] = [];
		const byWs = new Map<string, UnifiedSession[]>();
		const solo: UnifiedSession[] = [];
		for (const s of filtered) {
			if (s.automation) continue; // automations render in their own band
			if (s.projectId) {
				const list = byWs.get(s.projectId) || [];
				list.push(s);
				byWs.set(s.projectId, list);
			} else solo.push(s);
		}
		const mkRow = (
			key: string,
			workspace: Project | null,
			name: string,
			chats: UnifiedSession[],
		): WsRow => {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			const status =
				STATUS_PRIORITY.find((st) => chats.some((c) => mineStatus(c) === st)) ||
				"pending";
			return {
				key,
				workspace,
				name,
				chats,
				status,
				lastActivity: chats.reduce(
					(m, c) => (c.lastActivity > m ? c.lastActivity : m),
					"",
				),
				createdAt: chats[0]?.createdAt || "",
				unread: chats.some(
					(c) => c.id !== selectedId && isUnread(c.id, c.lastActivity, reads),
				),
				running: chats.some((c) => c.isRunning),
				owner: (workspace?.createdBy || chats[0]?.startedBy || "").toLowerCase(),
			};
		};
		for (const [wsId, chats] of byWs) {
			const ws = projects.find((p) => p.id === wsId) || null;
			rows.push(
				mkRow(`workspace:${wsId}`, ws, ws?.name || chats[0].title, chats),
			);
		}
		// Truly chatless workspaces still get a row — clicking opens the scoped New
		// palette. A workspace whose chats are all *automation* runs is NOT chatless
		// (those render in the Automations band), and neither is one whose chats
		// are all *archived* (archiving a workspace must not resurrect it as an
		// empty row) — so both get no row here.
		if (!search && filter.repo === "all") {
			const hasAnyChat = new Set(
				sessions.filter((s) => s.projectId).map((s) => s.projectId),
			);
			for (const p of projects) {
				if (!byWs.has(p.id) && !hasAnyChat.has(p.id))
					rows.push({
						key: `workspace:${p.id}`,
						workspace: p,
						name: p.name,
						chats: [],
						status: "pending",
						lastActivity: p.createdAt,
						createdAt: p.createdAt,
						unread: false,
						running: false,
						owner: (p.createdBy || "").toLowerCase(),
					});
			}
		}
		// Workspace-less chats (slack/linear sources + their bks- siblings) group
		// by shared isolated worktree — the SAME rule the tab strip uses — so the
		// sidebar and tabs always agree on what belongs together. Chats with no
		// isolated worktree stay solo rows.
		const byWorktree = new Map<string, UnifiedSession[]>();
		const loose: UnifiedSession[] = [];
		for (const s of solo) {
			if (s.worktreeDir?.startsWith("/home/ubuntu/worktrees/")) {
				const list = byWorktree.get(s.worktreeDir) || [];
				list.push(s);
				byWorktree.set(s.worktreeDir, list);
			} else loose.push(s);
		}
		for (const [dir, chats] of byWorktree) {
			chats.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
			// The branch is the row's stable name (chat titles drift as generated
			// titles land; the branch names the shared piece of work).
			rows.push(
				mkRow(`wt:${dir}`, null, chats[0].branch || chats[0].title, chats),
			);
		}
		for (const s of loose) rows.push(mkRow(s.id, null, s.title, [s]));
		const key = filter.sort === "created" ? "createdAt" : "lastActivity";
		rows.sort((a, b) => (b[key] || "").localeCompare(a[key] || ""));
		return rows;
	}, [filtered, sessions, projects, selectedId, reads, search, filter]);

	// Automations keep their own collapsible band, one group per automation —
	// hundreds of one-shot runs would drown the Workspaces list otherwise.
	const groups = useMemo(() => {
		const out: Group[] = [];
		const byAutomation = new Map<string, UnifiedSession[]>();
		for (const s of sorted) {
			if (!s.automation) continue;
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
	}, [sorted]);

	// Sessions in sidebar order (pinned rows first, then each group's items) —
	// used to hand onArchive the row that should become active when the open
	// session is archived away.
	const flatOrder = useMemo(() => {
		const pinned = pins
			.filter((e) => !e.startsWith("note:"))
			.map((id) =>
				sessions.find((s) => s.id === id || s.aliasIds?.includes(id)),
			)
			.filter((s): s is UnifiedSession => !!s);
		return [...pinned, ...groups.flatMap((g) => g.items)];
	}, [pins, sessions, groups]);

	function archiveWithNext(s: UnifiedSession) {
		const idx = flatOrder.findIndex((x) => x.id === s.id);
		const rest = flatOrder.filter((x) => x.id !== s.id);
		const next =
			idx >= 0 ? (rest[Math.min(idx, rest.length - 1)] ?? null) : (rest[0] ?? null);
		onArchive(s, next);
	}

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

	// The People / Automations bands are open by default, so — like
	// repo groups — their *collapsed* state is what's persisted. Collapsing one
	// hides every group within that band. Searching forces them open.
	const bandOpen = (band: GroupBand) =>
		search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);
	function toggleBand(band: GroupBand) {
		const key = `collapsed:band:${band}`;
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// The "Tools" nav band (Sessions / Reviews / Automations / … at the top) is
	// open by default, so — like the Projects/People/Automations bands — its
	// *collapsed* state is what's persisted, under a "collapsed:" key.
	const toolsOpen = !expanded.has("collapsed:tools");
	function toggleTools() {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has("collapsed:tools")) next.delete("collapsed:tools");
			else next.add("collapsed:tools");
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			return next;
		});
	}

	// Distinct open PRs (deduped by URL) — shown as a badge on the Reviews tab.
	const openPrCount = useMemo(() => {
		const urls = new Set<string>();
		for (const s of sessions) {
			if (s.prUrl && s.prState === "OPEN" && !s.archived) urls.add(s.prUrl);
		}
		return urls.size;
	}, [sessions]);

	// "Archived" reads as a peer of the My-sessions status buckets (Needs input /
	// Done …): an icon-led row that sits flush under them. Unlike those, it doesn't
	// expand inline — it navigates to the archived page, and highlights while that
	// page is open.
	const archivedBand =
		archivedCount > 0 ? (
			<button
				className={`sidebar-group-header sidebar-archived-row${
					archivedActive ? " active" : ""
				}`}
				onClick={onOpenArchived}
				title="View archived sessions"
			>
				<span className="sidebar-archived-icon">
					<svg
						width="18"
						height="18"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
						<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
						<path d="M6.5 8.5h3" strokeLinecap="round" />
					</svg>
				</span>
				<span className="sidebar-group-name">Archived</span>
				<span className="sidebar-group-count">{archivedCount}</span>
			</button>
		) : null;

	// One sidebar row per workspace: status dot (most urgent chat), name, chat
	// count, unread dot. Click opens the first chat (or the workspace itself for
	// real workspaces — App resolves that to its first chat / scoped New palette).
	// Right-click opens the workspace menu (pin / color / rename / delete);
	// double-click renames inline.
	function renderWsRow(row: WsRow) {
		const active = row.chats.some((s) => s.id === selectedId);
		const editing = row.workspace && editingProjectId === row.workspace.id;
		const waiting = row.status === "needsinput";
		return (
			<button
				key={row.key}
				className={`sidebar-item sidebar-ws-row ${active ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""} ${row.unread ? "sidebar-item-unread" : ""}`}
				onClick={() => {
					if (editing) return;
					if (row.workspace) onOpenProject(row.workspace.id);
					else if (row.chats[0]) onSelect(row.chats[0]);
				}}
				onContextMenu={(e) => {
					e.preventDefault();
					setProjectMenu({
						id: row.workspace ? row.workspace.id : row.key,
						x: e.clientX,
						y: e.clientY,
					});
				}}
				title={row.name}
			>
				{(waiting || row.running) && (
					<span
						className={`sidebar-item-status ${
							waiting ? "sidebar-status-waiting" : "sidebar-status-running"
						}`}
					/>
				)}
				{row.unread && !waiting && !row.running && (
					<span className="sidebar-item-status sidebar-status-unread" />
				)}
				{editing ? (
					<input
						className="sidebar-item-rename"
						value={projectDraft}
						autoFocus
						onChange={(e) => setProjectDraft(e.target.value)}
						onClick={(e) => e.stopPropagation()}
						onDoubleClick={(e) => e.stopPropagation()}
						onBlur={commitProjectRename}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitProjectRename();
							else if (e.key === "Escape") setEditingProjectId(null);
							e.stopPropagation();
						}}
					/>
				) : (
					<span
						className="sidebar-item-title"
						onDoubleClick={(e) => {
							e.stopPropagation();
							if (row.workspace) {
								setProjectDraft(row.workspace.name);
								setEditingProjectId(row.workspace.id);
							} else if (row.chats[0]) {
								// Solo chat rows rename the chat itself.
								const title = window
									.prompt("Rename chat", row.chats[0].title)
									?.trim();
								if (title !== undefined && title !== null)
									onRename(row.chats[0], title);
							}
						}}
					>
						{row.name}
					</span>
				)}
				{row.chats.length > 1 && (
					<span className="sidebar-group-count">{row.chats.length}</span>
				)}
				{row.lastActivity && (
					<span
						className="sidebar-ws-time"
						title={new Date(row.lastActivity).toLocaleString()}
					>
						{shortTime(row.lastActivity)}
					</span>
				)}
				{/* Hover actions: pin + archive, side by side (replace the count). */}
				<span className="sidebar-ws-actions">
					{(() => {
						const pinKey = row.workspace
							? `workspace:${row.workspace.id}`
							: row.key;
						// A row can be surfaced in Pinned by its own key OR by a legacy
						// pin on any member chat (incl. alias ids — e.g. a slack chat
						// pinned from its header ☆ long ago). Unpin must clear ALL of
						// them, or the row sticks in Pinned no matter what you click.
						const pinnedKeys = [
							pinKey,
							row.key,
							...row.chats.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
						].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
						const pinned = pinnedKeys.length > 0;
						const toggle = () => {
							if (pinned) {
								let next = pins;
								for (const k of pinnedKeys) next = togglePin(k);
								setPins(next);
							} else {
								setPins(togglePin(pinKey));
							}
						};
						return (
							<span
								role="button"
								tabIndex={0}
								className={`sidebar-ws-action${pinned ? " is-on" : ""}`}
								title={pinned ? "Unpin workspace" : "Pin workspace"}
								onClick={(e) => {
									e.stopPropagation();
									toggle();
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.stopPropagation();
										toggle();
									}
								}}
							>
								<svg width="16" height="16" viewBox="0 0 16 16" fill={pinned ? "currentColor" : "none"}>
									<path
										d="M8 1.8l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.5l-3.8 2 .72-4.23-3.07-3 4.25-.62L8 1.8z"
										stroke="currentColor"
										strokeWidth="1.4"
										strokeLinejoin="round"
									/>
								</svg>
							</span>
						);
					})()}
					{row.chats.length > 0 && (
						<span
							role="button"
							tabIndex={0}
							className="sidebar-ws-action"
							title={
								row.chats.length > 1
									? `Archive workspace (${row.chats.length} chats)`
									: "Archive"
							}
							onClick={(e) => {
								e.stopPropagation();
								onArchiveWorkspace(row.chats);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.stopPropagation();
									onArchiveWorkspace(row.chats);
								}
							}}
						>
							<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
								<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
								<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
								<path d="M6.5 8.5h3" strokeLinecap="round" />
							</svg>
						</span>
					)}
				</span>
			</button>
		);
	}

	return (
		<div className="sidebar">
			<div className="sidebar-search-wrap">
				<svg
					className="sidebar-search-icon"
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
				>
					<circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
					<path
						d="M14 14L10.7 10.7"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
				{/* Acts as a button: clicking (or focusing) it opens the ⌘K
				    session-search palette rather than filtering inline. */}
				<input
					className="sidebar-search"
					type="text"
					placeholder="Search sessions"
					value=""
					readOnly
					onMouseDown={(e) => {
						e.preventDefault();
						onOpenSearch();
					}}
					onFocus={onOpenSearch}
				/>
				<kbd className="sidebar-search-kbd">⌘K</kbd>
			</div>

			{(() => {
				// Follow rail: teammates (not me) currently viewing a session. Click
				// = follow them (navigation shadows theirs); click again = unfollow.
				const others = teamViewing.filter((v) => v.user !== currentUser);
				if (others.length === 0) return null;
				const titleFor = (id: string) =>
					sessions.find((s) => s.id === id)?.title || id;
				return (
					<div className="px-3 py-1.5 flex flex-col gap-1 border-b border-line">
						{others.map((v) => (
							<button
								key={v.user}
								className={`flex items-center gap-2 min-w-0 text-left text-[12px] bg-transparent border-0 cursor-pointer rounded-md px-1.5 py-1 hover:bg-hover ${
									followUser === v.user ? "bg-active" : ""
								}`}
								onClick={() => onToggleFollow?.(v.user)}
								title={
									followUser === v.user
										? `Following ${v.user} — click to stop`
										: `${v.user} is viewing “${titleFor(v.sessionId)}” — click to follow along`
								}
							>
								<span
									className="w-[7px] h-[7px] rounded-full shrink-0"
									style={{ backgroundColor: personColor(v.user) }}
								/>
								<span className="text-fg shrink-0">{v.user}</span>
								<span className="text-faint truncate">
									{titleFor(v.sessionId)}
								</span>
								{followUser === v.user && (
									<span className="text-accent text-[10px] uppercase tracking-wide ml-auto shrink-0">
										following
									</span>
								)}
							</button>
						))}
					</div>
				);
			})()}

			<div className="sidebar-tools">
				<div className="sidebar-band-label sidebar-tools-head">
					<button
						className="sidebar-band-toggle"
						onClick={toggleTools}
						title={toolsOpen ? "Collapse tools" : "Expand tools"}
					>
						<span>Tools</span>
						<IconChevronDown
							className="sidebar-band-chevron"
							size={16}
							style={{ transform: toolsOpen ? "none" : "rotate(-90deg)" }}
						/>
					</button>
				</div>
				{toolsOpen && (
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
				)}
			</div>

			<div
				className={`sidebar-workspace${listScrolled ? " sidebar-workspace--scrolled" : ""}`}
			>
				<div className="sidebar-workspace-head" ref={headRef}>
					<span className="sidebar-workspace-title" ref={titleRef}>
						{filter.person !== "all"
							? `${people.find((p) => p.key === filter.person)?.label || filter.person}'s workspaces`
							: "Workspaces"}
					</span>
					{/* Repo filter chip, inline behind the title when it fits. */}
					{filter.repo !== "all" && repoInline && (
						<RepoFilterChip
							repo={filter.repo}
							onClear={() => setFilter({ repo: "all" })}
							variant="inline"
						/>
					)}
					<div className="sidebar-workspace-spacer" />
					<div className="sidebar-workspace-actions" ref={actionsRef}>
						<Tooltip label="Group, filter & sort">
						<button
							ref={filterBtnRef}
							className={`sidebar-new-btn sidebar-filter-btn${
								filterOpen ? " active" : ""
							}${
								filter.groupBy !== "status" ||
								filter.repo !== "all" ||
								filter.person !== "all"
									? " has-filter"
									: ""
							}`}
							onClick={() => setFilterOpen((o) => !o)}
						>
							<svg width="18" height="18" viewBox="0 0 16 16" fill="none">
								<path
									d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
								/>
							</svg>
						</button>
						</Tooltip>
						<Tooltip label="New workspace">
						<button
							className="sidebar-new-btn"
							onClick={onNewSession}
						>
							<svg width="18" height="18" viewBox="0 0 16 16" fill="none">
								<path
									d="M1.75 4.25c0-.55.45-1 1-1h3.1c.32 0 .62.15.8.4l.7.95h5.1c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.25z"
									stroke="currentColor"
									strokeWidth="1.4"
									strokeLinejoin="round"
								/>
								<path
									d="M8 6.8v3.4M6.3 8.5h3.4"
									stroke="currentColor"
									strokeWidth="1.4"
									strokeLinecap="round"
								/>
							</svg>
						</button>
						</Tooltip>
						<Tooltip label="New session">
						<button
							className="sidebar-new-btn"
							onClick={onNewSession}
						>
							+
						</button>
						</Tooltip>
					</div>
					{/* Off-layout probe: measures the chip's natural width so the effect
					    above can decide whether it fits inline (never rendered visibly). */}
					{filter.repo !== "all" && (
						<RepoFilterChip repo={filter.repo} variant="probe" ref={probeRef} />
					)}
				</div>

				{/* Fallback row: only when the chip doesn't fit inline. */}
				{filter.repo !== "all" && !repoInline && (
					<div className="sidebar-repo-row">
						<RepoFilterChip
							repo={filter.repo}
							onClear={() => setFilter({ repo: "all" })}
							variant="row"
						/>
					</div>
				)}
			</div>

			{filterOpen && (
				<FilterPopover
					anchor={filterBtnRef.current}
					filter={filter}
					repos={repos}
					people={people}
					onChange={setFilter}
					onClose={() => setFilterOpen(false)}
				/>
			)}

			{projectMenu &&
				createPortal(
					(() => {
						// The menu id is a real workspace id, or a solo chat's session id
						// (pre-migration standalone rows). Solo rows get pin/archive only.
						const ws = projects.find((p) => p.id === projectMenu.id);
						const soloChat = ws
							? null
							: sessions.find((s) => s.id === projectMenu.id);
						const pinKey = ws ? `workspace:${ws.id}` : projectMenu.id;
						// Match the row pin icon: a row can be pinned via its own key or a
						// legacy pin on any member chat (incl. alias ids) — unpin clears all.
						const menuRow = wsRows.find((r) =>
							ws ? r.workspace?.id === ws.id : r.key === projectMenu.id,
						);
						const pinnedKeys = [
							pinKey,
							...(menuRow
								? [
										menuRow.key,
										...menuRow.chats.flatMap((c) => [
											c.id,
											...(c.aliasIds || []),
										]),
									]
								: []),
						].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
						const pinned = pinnedKeys.length > 0;
						return (
							<div
								className="sidebar-ctx-menu"
								style={{ ...CTX_MENU_STYLE, left: projectMenu.x, top: projectMenu.y }}
								onClick={(e) => e.stopPropagation()}
							>
								<button
									style={CTX_ITEM_STYLE}
									onClick={() => {
										if (pinned) {
											let next = pins;
											for (const k of pinnedKeys) next = togglePin(k);
											setPins(next);
										} else {
											setPins(togglePin(pinKey));
										}
										setProjectMenu(null);
									}}
								>
									{pinned ? "Unpin" : "Pin"}
								</button>
								<div style={CTX_SEP_STYLE} />
								{ws && (
									<>
										<div
											style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 6px 2px" }}
										>
											{TAB_COLORS.map((c) => (
												<button
													key={c.key}
													type="button"
													className="tab-color-swatch"
													style={{ background: c.hex }}
													aria-label={c.label}
													title={c.label}
													onClick={() => {
														onSetProjectColor(projectMenu.id, c.key);
														setProjectMenu(null);
													}}
												/>
											))}
											<button
												type="button"
												className="tab-color-swatch tab-color-swatch-none"
												aria-label="No color"
												title="No color"
												onClick={() => {
													onSetProjectColor(projectMenu.id, null);
													setProjectMenu(null);
												}}
											/>
										</div>
										<div style={CTX_SEP_STYLE} />
										<button
											style={CTX_ITEM_STYLE}
											onClick={() => {
												setProjectDraft(ws.name);
												setEditingProjectId(ws.id);
												setProjectMenu(null);
											}}
										>
											Rename
										</button>
										<button
											style={{ ...CTX_ITEM_STYLE, color: "var(--red, #e5534b)" }}
											onClick={() => {
												if (
													window.confirm(
														`Delete workspace "${ws.name}"? Its chats become standalone.`,
													)
												)
													onDeleteProject(projectMenu.id);
												setProjectMenu(null);
											}}
										>
											Delete workspace
										</button>
									</>
								)}
								{soloChat && (
									<button
										style={CTX_ITEM_STYLE}
										onClick={() => {
											onArchive(soloChat, null);
											setProjectMenu(null);
										}}
									>
										Archive
									</button>
								)}
							</div>
						);
					})(),
					document.body,
				)}

			<div
				className="sidebar-list"
				onScroll={(e) => {
					const scrolled = e.currentTarget.scrollTop > 0;
					setListScrolled((prev) => (prev === scrolled ? prev : scrolled));
				}}
			>
				{/* ── Pinned (workspaces + notes, mixed) ── */}
				{(() => {
					const pinSet = new Set(pins);
					// A row is pinned via its own key (`workspace:<id>` or a solo chat
					// id) or via a legacy pin of any member chat.
					const pinnedRows = wsRows.filter(
						(r) =>
							pinSet.has(r.key) || r.chats.some((c) => pinSet.has(c.id)),
					);
					// Pinned chats that don't map to a workspace row (automation runs).
					const rowChatIds = new Set(
						wsRows.flatMap((r) => r.chats.map((c) => c.id)),
					);
					const pinnedLoose = pins
						.filter((e) => !e.startsWith("note:") && !e.startsWith("workspace:"))
						.filter((id) => !rowChatIds.has(id))
						.map((id) =>
							sessions.find(
								(s) => s.id === id || s.aliasIds?.includes(id),
							),
						)
						.filter((s): s is UnifiedSession => !!s);
					const pinnedNotes = pins
						.filter((e) => e.startsWith("note:"))
						.map((e) => notes.find((n) => n.id === e.slice(5)))
						.filter((n): n is { id: string; title: string } => !!n);
					if (!pinnedRows.length && !pinnedLoose.length && !pinnedNotes.length)
						return null;
					const pinnedOpen = isOpen("pinned");
					const pinnedCount =
						pinnedRows.length + pinnedLoose.length + pinnedNotes.length;
					return (
						<div className="sidebar-group">
							{/* Same header treatment as the status lanes below. */}
							<button
								className="sidebar-group-header"
								onClick={() => toggleGroup("pinned")}
							>
								<span
									className="sidebar-group-dot"
									style={{ backgroundColor: "var(--text-faint)" }}
								/>
								<span className="sidebar-group-name">Pinned</span>
								<IconChevronDown
									className="sidebar-group-chevron"
									size={14}
									style={{ transform: pinnedOpen ? "none" : "rotate(-90deg)" }}
								/>
								<span className="sidebar-group-count">{pinnedCount}</span>
							</button>
							{pinnedOpen && pinnedRows.map(renderWsRow)}
							{pinnedOpen &&
								pinnedLoose.map((s) => (
								<SidebarItem
									key={`pin-${s.id}`}
									session={s}
									selected={s.id === selectedId}
									unread={
										s.id !== selectedId &&
										isUnread(s.id, s.lastActivity, reads)
									}
									mine={
										!!s.startedBy &&
										!s.automation &&
										s.startedBy.toLowerCase() === currentUser.toLowerCase()
									}
									onClick={() => onSelect(s)}
									onArchive={() => archiveWithNext(s)}
									onRename={(title) => onRename(s, title)}
									projects={projects}
									onMoveToProject={(pid) => onSetSessionProject(s.id, pid)}
								/>
							))}
							{pinnedOpen &&
								pinnedNotes.map((n) => (
									<button
										key={`pin-note-${n.id}`}
										className={`sidebar-item ${n.id === activeNoteId ? "sidebar-item-selected" : ""}`}
										onClick={() => onOpenNote(n.id)}
										title={n.title}
									>
										<span style={{ marginRight: 6, opacity: 0.9 }}>📝</span>
										<span className="sidebar-item-title">{n.title}</span>
									</button>
								))}
						</div>
					);
				})()}

				{/* ── Workspaces: status lanes live directly under the Workspaces
				    header above (which carries the filter, new-workspace and
				    new-session actions) — no second in-list heading. ── */}
				<div className="sidebar-group">
					{/* Status groups over the focus person's workspaces. The Person
					    filter defaults to you; picking a teammate shows their groups
					    instead (and hides the People band below). */}
					{(() => {
						const pinSet = new Set(pins);
						const focus =
							filter.person !== "all"
								? filter.person
								: currentUser.toLowerCase();
						const focusRows = wsRows.filter(
							(r) =>
								r.owner === focus &&
								!pinSet.has(r.key) &&
								!r.chats.some((c) => pinSet.has(c.id)),
						);
						// Empty status groups are hidden — only lanes with sessions render.
						return MINE_STATUS_META.map((meta) => {
							const items = focusRows.filter((r) => r.status === meta.key);
							if (items.length === 0) return null;
							const gkey = `status:${meta.key}`;
							const open = isOpen(gkey);
							return (
								<React.Fragment key={gkey}>
									<button
										className="sidebar-group-header"
										onClick={() => toggleGroup(gkey)}
									>
										<span
											className="sidebar-group-dot"
											style={{ backgroundColor: meta.dotColor }}
										/>
										<span className="sidebar-group-name">{meta.label}</span>
										<IconChevronDown
											className="sidebar-group-chevron"
											size={14}
											style={{ transform: open ? "none" : "rotate(-90deg)" }}
										/>
										<span className="sidebar-group-count">{items.length}</span>
									</button>
									{items
										.filter(
											(r) =>
												open || r.chats.some((c) => c.id === selectedId),
										)
										.map(renderWsRow)}
								</React.Fragment>
							);
						});
					})()}
				</div>

				{archivedBand && (
					<div className="sidebar-group">{archivedBand}</div>
				)}

				{/* People browsing lives in the Person filter (funnel icon) — pick a
				    teammate there to see their status lanes instead of yours. */}
				{/* ── Automations (one collapsible band, one group per automation) ── */}
				{groups.length > 0 && (
					<div className="sidebar-group sidebar-group--automations sidebar-group--band-start">
						<div className="sidebar-band-label">
							<button
								className="sidebar-band-toggle"
								onClick={() => toggleBand("automations")}
								title={
									bandOpen("automations")
										? "Collapse automations"
										: "Expand automations"
								}
							>
								<span>Automations</span>
								<IconChevronDown
									className="sidebar-band-chevron"
									size={16}
									style={{
										transform: bandOpen("automations")
											? "none"
											: "rotate(-90deg)",
									}}
								/>
								{!bandOpen("automations") && (
									<span className="sidebar-group-count">
										{groups.reduce((n, g) => n + g.items.length, 0)}
									</span>
								)}
							</button>
						</div>
						{bandOpen("automations") &&
							groups.map((group) => {
								const open = isOpen(group.key);
								return (
									<React.Fragment key={group.key}>
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
											<IconChevronDown
												className="sidebar-group-chevron"
												size={14}
												style={{
													transform: open ? "none" : "rotate(-90deg)",
												}}
											/>
											<span className="sidebar-group-count">
												{group.items.length}
											</span>
										</button>
										{/* When collapsed, still surface the actively selected
										    session so it never disappears behind a closed header. */}
										{group.items
											.filter((s) => open || s.id === selectedId)
											.map((s) => (
												<SidebarItem
													key={s.id}
													session={s}
													selected={s.id === selectedId}
													unread={
														s.id !== selectedId &&
														isUnread(s.id, s.lastActivity, reads)
													}
													mine={
														!!s.startedBy &&
														!s.automation &&
														s.startedBy.toLowerCase() ===
															currentUser.toLowerCase()
													}
													onClick={() => onSelect(s)}
													onArchive={() => archiveWithNext(s)}
													onRename={(title) => onRename(s, title)}
													projects={projects}
													onMoveToProject={(pid) =>
														onSetSessionProject(s.id, pid)
													}
												/>
											))}
									</React.Fragment>
								);
							})}
					</div>
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
	people,
	onChange,
	onClose,
}: {
	anchor: HTMLElement | null;
	filter: FilterState;
	repos: string[];
	people: Array<{ key: string; label: string }>;
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

	const personOptions: SelectOption[] = [
		{ value: "all", label: "All people" },
		...people.map(({ key, label }) => ({
			value: key,
			label,
			icon: (
				<span
					className="sidebar-group-dot"
					style={{ backgroundColor: personColor(key) }}
				/>
			),
		})),
	];

	return createPortal(
		<>
			<div className="menu-backdrop" onClick={onClose} />
			<div className="filter-popover" style={{ left, top, width }}>
				<div className="filter-row">
					<span className="filter-row-label">Repo</span>
					<MiniSelect
						value={filter.repo}
						options={repoOptions}
						onSelect={(v) => onChange({ repo: v })}
					/>
				</div>
				<div className="filter-row">
					<span className="filter-row-label">Person</span>
					<MiniSelect
						value={filter.person}
						options={personOptions}
						onSelect={(v) => onChange({ person: v })}
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

// The removable "active repo filter" chip. Rendered in three variants:
// "inline" (in the header, behind the title), "row" (its own line under the
// header) and "probe" (an off-layout copy used only to measure natural width —
// non-interactive and hidden from a11y).
const RepoFilterChip = React.forwardRef<
	HTMLSpanElement,
	{ repo: string; onClear?: () => void; variant: "inline" | "row" | "probe" }
>(function RepoFilterChip({ repo, onClear, variant }, ref) {
	const probe = variant === "probe";
	return (
		<span
			ref={ref}
			className={`sidebar-repo-chip sidebar-repo-chip--${variant}`}
			aria-hidden={probe || undefined}
		>
			<RepoTile name={repo} />
			<span className="sidebar-repo-chip-name">{repo}</span>
			<button
				className="sidebar-repo-chip-x"
				title="Clear repo filter"
				tabIndex={probe ? -1 : undefined}
				onClick={probe ? undefined : onClear}
			>
				×
			</button>
		</span>
	);
});

function SidebarItem({
	session,
	selected,
	unread,
	mine,
	onClick,
	onArchive,
	onRename,
	projects,
	onMoveToProject,
}: {
	session: UnifiedSession;
	selected: boolean;
	/** New activity since this session was last opened — draws an iMessage-style
	    unread dot and bolds the title. */
	unread: boolean;
	/** The current user's own session — the owner name is redundant, so it's
	    dropped and the timestamp moves up onto the title line. */
	mine: boolean;
	onClick: () => void;
	onArchive: () => void;
	onRename: (title: string) => void;
	/** When provided, right-click offers "Move to project" (projects list + None). */
	projects?: Project[];
	onMoveToProject?: (projectId: string | null) => void;
}) {
	const running = session.isRunning;
	const waiting = !!session.waitingForInput;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Right-click context menu (move-to-project) anchored at the cursor.
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!ctxMenu) return;
		const close = () => setCtxMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [ctxMenu]);

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

	// Mobile long-press → action sheet, and — importantly — the *tap* to open a
	// session is driven from `touchend`, not the synthesized `click`. `.sidebar-item`
	// has `:hover` styles (the reveal-on-hover X, the hover background), and iOS
	// treats the first tap on a hover-styled element as a hover-in, swallowing the
	// click — so a click-driven open needs a second tap ("first tap doesn't work").
	// Firing on touchend sidesteps that entirely. A hold that stays roughly in
	// place for LONG_PRESS_MS opens the sheet instead; any real finger travel (a
	// scroll) cancels both.
	const [sheetOpen, setSheetOpen] = useState(false);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressOrigin = useRef<{ x: number; y: number } | null>(null);
	const longPressed = useRef(false);
	const moved = useRef(false);

	function clearPress() {
		if (pressTimer.current) clearTimeout(pressTimer.current);
		pressTimer.current = null;
		pressOrigin.current = null;
	}
	function onTouchStart(e: React.TouchEvent) {
		if (editing || e.touches.length !== 1) return;
		const t = e.touches[0];
		longPressed.current = false;
		moved.current = false;
		clearPress();
		// After clearPress (which nulls it) so it survives to onTouchMove/onTouchEnd.
		pressOrigin.current = { x: t.clientX, y: t.clientY };
		pressTimer.current = setTimeout(() => {
			longPressed.current = true;
			closeHover();
			navigator.vibrate?.(10);
			setSheetOpen(true);
		}, LONG_PRESS_MS);
	}
	function onTouchMove(e: React.TouchEvent) {
		const o = pressOrigin.current;
		if (!o || e.touches.length !== 1) return;
		const t = e.touches[0];
		if (
			Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
			Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
		) {
			moved.current = true;
			clearPress();
		}
	}
	function onTouchEnd(e: React.TouchEvent) {
		const hadOrigin = pressOrigin.current !== null;
		clearPress();
		if (editing) return;
		// A clean tap: it started on this row, never became a long-press, and
		// never turned into a scroll. Open now and swallow the ghost click iOS
		// would fire ~300ms later (which the :hover heuristic may drop anyway).
		if (hadOrigin && !longPressed.current && !moved.current) {
			e.preventDefault();
			onClick();
		}
	}

	function commitRename() {
		onRename(draft.trim());
		setEditing(false);
	}

	const metaParts: React.ReactNode[] = [];
	// In "My sessions" the owner is always the current user, so hide it.
	if (!mine && session.startedBy && !session.automation) {
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
			className={`sidebar-item ${!mine ? "sidebar-item--twoline" : ""} ${selected ? "sidebar-item-selected" : ""} ${waiting ? "sidebar-item-waiting" : ""} ${unread ? "sidebar-item-unread" : ""}`}
			onClick={(e) => {
				// Touch taps are handled on touchend (and their ghost click is
				// preventDefault'd), so this path is the mouse/desktop one. Still
				// swallow a click that ends a long-press, as a belt-and-suspenders.
				if (longPressed.current) {
					longPressed.current = false;
					e.preventDefault();
					return;
				}
				onClick();
			}}
			onMouseEnter={openHover}
			onMouseLeave={closeHover}
			onMouseDown={closeHover}
			onTouchStart={onTouchStart}
			onTouchMove={onTouchMove}
			onTouchEnd={onTouchEnd}
			onTouchCancel={clearPress}
			onContextMenu={(e) => {
				// On touch this is the long-press callout: the action sheet
				// owns that gesture, so suppress the desktop menu (and the
				// native text-selection callout) rather than stacking both.
				if (longPressed.current || pressOrigin.current) {
					e.preventDefault();
					return;
				}
				if (!onMoveToProject) return;
				e.preventDefault();
				closeHover();
				setCtxMenu({ x: e.clientX, y: e.clientY });
			}}
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
				{/* Unread dot — only when there's no live status dot already drawing
				    the eye (a running/waiting session isn't "unread" in the same
				    sense). */}
				{unread && !waiting && !running && (
					<span className="sidebar-item-status sidebar-status-unread" />
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
				{mine && !editing && (
					<span className="sidebar-item-inline-meta">
						{metaParts.map((part, i) => (
							<React.Fragment key={i}>
								{i > 0 && <span className="sidebar-meta-sep">·</span>}
								{part}
							</React.Fragment>
						))}
					</span>
				)}
			</div>
			{!mine && (
				<div className="sidebar-item-meta">
					{metaParts.map((part, i) => (
						<React.Fragment key={i}>
							{i > 0 && <span className="sidebar-meta-sep">·</span>}
							{part}
						</React.Fragment>
					))}
				</div>
			)}
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
				<svg
					width="16"
					height="16"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
				>
					<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
					<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
					<path d="M6.5 8.5h3" strokeLinecap="round" />
				</svg>
			</span>
		</button>
		{anchor && <SessionHoverCard session={session} anchor={anchor} />}
		{ctxMenu &&
			onMoveToProject &&
			createPortal(
				<div
					style={{ ...CTX_MENU_STYLE, left: ctxMenu.x, top: ctxMenu.y }}
					onClick={(e) => e.stopPropagation()}
				>
					<div style={CTX_LABEL_STYLE}>Move to project</div>
					{(projects || []).map((p) => (
						<button
							key={p.id}
							style={{
								...CTX_ITEM_STYLE,
								...(session.projectId === p.id
									? { color: "var(--accent)", fontWeight: 600 }
									: {}),
							}}
							onClick={() => {
								onMoveToProject(p.id);
								setCtxMenu(null);
							}}
						>
							{p.name}
						</button>
					))}
					{(projects || []).length === 0 && (
						<div style={{ ...CTX_LABEL_STYLE, textTransform: "none" }}>
							No projects yet
						</div>
					)}
					<div style={CTX_SEP_STYLE} />
					<button
						style={{
							...CTX_ITEM_STYLE,
							...(!session.projectId
								? { color: "var(--accent)", fontWeight: 600 }
								: {}),
						}}
						onClick={() => {
							onMoveToProject(null);
							setCtxMenu(null);
						}}
					>
						None (standalone)
					</button>
				</div>,
				document.body,
			)}
			{sheetOpen && (
				<MobileActionSheet
					session={session}
					projects={projects}
					onMoveToProject={onMoveToProject}
					onRename={() => {
						setDraft(session.title);
						setEditing(true);
					}}
					onArchive={onArchive}
					onClose={() => setSheetOpen(false)}
				/>
			)}
		</>
	);
}

// The bottom sheet raised by long-pressing a session row on touch. It gathers
// the per-session actions that live behind hover/right-click on desktop
// (rename, move-to-project, archive) into thumb-sized rows. "Move to project"
// swaps the sheet to a second step listing the projects rather than nesting a
// menu. Rendered in a portal over a dimmed, tap-to-dismiss backdrop.
function MobileActionSheet({
	session,
	projects,
	onMoveToProject,
	onRename,
	onArchive,
	onClose,
}: {
	session: UnifiedSession;
	projects?: Project[];
	onMoveToProject?: (projectId: string | null) => void;
	onRename: () => void;
	onArchive: () => void;
	onClose: () => void;
}) {
	const [step, setStep] = useState<"main" | "project">("main");
	// Lock the page behind the sheet so a scroll drags the list, not the page.
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	const check = <span className="mobile-sheet-item-check">✓</span>;
	return createPortal(
		<div className="mobile-action-sheet-backdrop" onClick={onClose}>
			<div
				className="mobile-action-sheet"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mobile-sheet-grip" />
				{step === "main" ? (
					<>
						<div className="mobile-sheet-title">{session.title}</div>
						<button
							className="mobile-sheet-item"
							onClick={() => {
								onRename();
								onClose();
							}}
						>
							<svg
								width="18"
								height="18"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
							>
								<path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
							</svg>
							Rename
						</button>
						{onMoveToProject && (
							<button
								className="mobile-sheet-item"
								onClick={() => setStep("project")}
							>
								<svg
									width="18"
									height="18"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.4"
								>
									<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
								</svg>
								Move to project
								<span className="mobile-sheet-item-chevron">›</span>
							</button>
						)}
						<div className="mobile-sheet-sep" />
						<button
							className="mobile-sheet-item mobile-sheet-item--danger"
							onClick={() => {
								onArchive();
								onClose();
							}}
						>
							<svg
								width="18"
								height="18"
								viewBox="0 0 16 16"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
							>
								<rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
								<path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
								<path d="M6.5 8.5h3" strokeLinecap="round" />
							</svg>
							Archive
						</button>
					</>
				) : (
					<>
						<div className="mobile-sheet-title">Move to project</div>
						{(projects || []).map((p) => (
							<button
								key={p.id}
								className="mobile-sheet-item"
								onClick={() => {
									onMoveToProject?.(p.id);
									onClose();
								}}
							>
								{p.name}
								{session.projectId === p.id && check}
							</button>
						))}
						{(projects || []).length === 0 && (
							<div className="mobile-sheet-empty">No projects yet</div>
						)}
						<div className="mobile-sheet-sep" />
						<button
							className="mobile-sheet-item"
							onClick={() => {
								onMoveToProject?.(null);
								onClose();
							}}
						>
							None (standalone)
							{!session.projectId && check}
						</button>
					</>
				)}
			</div>
		</div>,
		document.body,
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

	const repoLabel = s.repo || "tella-fusion";
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
