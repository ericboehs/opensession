import React, { useMemo, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import { closePrPreviewApi, relativeTime, type OpenPr } from "../lib/api";
import {
	buildReviewQueue,
	type ReviewBucket,
	type ReviewQueueItem,
} from "../lib/review-queue";
import { githubLoginFor } from "./UserAvatar";
import {
	IconCheck,
	IconArrowUpRight,
	IconChevronDown,
	IconClock,
	IconFilter,
	IconGitMerge,
	IconMessageQuestion,
	IconX,
} from "./icons";
import { ContextMenu, Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { providerFromUrl } from "../lib/provider";

const FILTER_KEY = "opensession-review-queue-filter";

interface ReviewFilter {
	mine: boolean;
	requested: boolean;
	automation: boolean;
	other: boolean;
	repo: string;
	session: "all" | "with" | "without";
}

const DEFAULT_FILTER: ReviewFilter = {
	mine: true,
	requested: true,
	automation: false,
	other: false,
	repo: "all",
	session: "all",
};

function readFilter(): ReviewFilter {
	try {
		const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
		if (!saved) return DEFAULT_FILTER;
		return {
			mine: saved.mine !== false,
			requested: saved.requested !== false,
			automation: saved.automation === true,
			other: saved.other === true,
			repo: typeof saved.repo === "string" ? saved.repo : "all",
			session:
				saved.session === "with" || saved.session === "without"
					? saved.session
					: "all",
		};
	} catch {
		return DEFAULT_FILTER;
	}
}

const GROUPS: Array<{
	key: ReviewBucket;
	label: string;
}> = [
	{ key: "ready", label: "Ready to merge" },
	{ key: "attention", label: "Needs your attention" },
	{ key: "waiting", label: "Waiting" },
];

function GroupIcon({ bucket }: { bucket: ReviewBucket }) {
	const props = { className: "sidebar-group-icon", size: 20 };
	if (bucket === "ready") return <IconGitMerge {...props} />;
	if (bucket === "attention") return <IconMessageQuestion {...props} />;
	return <IconClock {...props} />;
}

function exactDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function statusTone(item: ReviewQueueItem): string {
	if (item.bucket === "ready") return "text-green";
	if (
		item.status.includes("failing") ||
		item.status === "Merge conflict" ||
		item.status === "Changes requested"
	)
		return "text-red";
	return item.bucket === "attention" ? "text-yellow" : "text-faint";
}

function rowStatus(item: ReviewQueueItem): string | null {
	if (item.bucket === "ready") return null;
	if (
		item.status === "Review requested" ||
		item.status === "Review needed" ||
		item.status === "Awaiting review"
	)
		return null;
	return item.status;
}

function RowIcon({ bucket }: { bucket: ReviewBucket }) {
	if (bucket === "ready")
		return <IconGitMerge className="shrink-0 text-green" size={17} />;
	return (
		<span className="flex size-[17px] shrink-0 items-center justify-center">
			<span
				className={`size-[7px] rounded-full ${bucket === "attention" ? "bg-yellow" : "bg-faint"}`}
			/>
		</span>
	);
}

interface Props {
	prs: OpenPr[];
	sessions: UnifiedSession[];
	currentUser: string;
	open: boolean;
	onToggle: () => void;
	groupOpen: (bucket: ReviewBucket) => boolean;
	onToggleGroup: (bucket: ReviewBucket) => void;
	selectedPr?: { repo: string; branch: string } | null;
	selectedReviewId?: string | null;
	/** The open workspace (route or the open chat's), for row selection —
	 *  a PR row is selected when that workspace carries its PR. */
	selectedWorkspace?: {
		repo?: string;
		branch?: string;
		prNumber?: number;
	} | null;
	/** Open the PR's workspace (resolve-or-create, Review tab). */
	onOpenItem: (item: ReviewQueueItem) => void;
}

export function ReviewQueue({
	prs,
	sessions,
	currentUser,
	open,
	onToggle,
	groupOpen,
	onToggleGroup,
	selectedPr,
	selectedReviewId,
	selectedWorkspace,
	onOpenItem,
}: Props) {
	const [filter, setFilterState] = useState<ReviewFilter>(readFilter);
	const [closingUrls, setClosingUrls] = useState<Set<string>>(() => new Set());
	const [closeError, setCloseError] = useState<string | null>(null);
	const githubLogin = githubLoginFor(currentUser);
	const allItems = useMemo(
		() => buildReviewQueue(prs, sessions, currentUser, githubLogin),
		[prs, sessions, currentUser, githubLogin],
	);
	const repos = useMemo(
		() => [...new Set(allItems.map((item) => item.pr.repo))].sort(),
		[allItems],
	);

	function setFilter(patch: Partial<ReviewFilter>) {
		setFilterState((previous) => {
			const next = { ...previous, ...patch };
			localStorage.setItem(FILTER_KEY, JSON.stringify(next));
			return next;
		});
	}

	async function closePr(item: ReviewQueueItem) {
		if (!window.confirm(`Close PR #${item.pr.number} without merging it?`)) return;
		setClosingUrls((current) => new Set(current).add(item.pr.url));
		setCloseError(null);
		try {
			await closePrPreviewApi(item.pr.repo, item.pr.branch);
		} catch (error: any) {
			setCloseError(error.message || `Failed to close PR #${item.pr.number}.`);
		} finally {
			setClosingUrls((current) => {
				const next = new Set(current);
				next.delete(item.pr.url);
				return next;
			});
		}
	}

	const visible = allItems.filter((item) => {
		if (filter.repo !== "all" && item.pr.repo !== filter.repo) return false;
		if (filter.session === "with" && !item.sessionId) return false;
		if (filter.session === "without" && item.sessionId) return false;
		return filter[item.source];
	});
	const byBucket = new Map<ReviewBucket, ReviewQueueItem[]>(
		GROUPS.map(({ key }) => [
			key,
			visible.filter((item) => item.bucket === key),
		]),
	);
	const actionable =
		(byBucket.get("ready")?.length || 0) +
		(byBucket.get("attention")?.length || 0);
	const customFilter =
		!filter.mine ||
		!filter.requested ||
		filter.automation ||
		filter.other ||
		filter.repo !== "all" ||
		filter.session !== "all";

	return (
		<div className="sidebar-independent-section sidebar-group--band-start">
			<div className="sidebar-band-label sidebar-sticky-head flex items-center gap-1">
				<button
					className="sidebar-band-toggle min-w-0 flex-1"
					onClick={onToggle}
					title={open ? "Collapse pull requests" : "Expand pull requests"}
				>
					<span className="sidebar-band-name">Pull requests</span>
					<span className="sidebar-group-count">{actionable}</span>
					<IconChevronDown
						className="sidebar-band-chevron"
						size={18}
						style={{ transform: open ? "none" : "rotate(-90deg)" }}
					/>
				</button>
				<Menu.Root>
					<Menu.Trigger
						className={`sidebar-band-action sidebar-filter-btn${customFilter ? " has-filter" : ""}`}
						aria-label="Filter pull requests"
						title="Filter pull requests"
					>
						<IconFilter size={19} />
					</Menu.Trigger>
					<Menu.Popup align="end" sideOffset={5} className="min-w-[250px]">
						<Menu.Group>
							<Menu.GroupLabel>Include</Menu.GroupLabel>
							<FilterItem
								checked={filter.mine}
								label="My pull requests"
								detail={`Created by ${githubLogin || currentUser}`}
								onChange={(mine) => setFilter({ mine })}
							/>
							<FilterItem
								checked={filter.requested}
								label="Review requests"
								detail="You are explicitly requested"
								onChange={(requested) => setFilter({ requested })}
							/>
							<FilterItem
								checked={filter.automation}
								label="tella-butler pull requests"
								detail="Automation-created changes"
								onChange={(automation) => setFilter({ automation })}
							/>
							<Menu.Separator />
							<FilterItem
								checked={filter.other}
								label="Everyone else's PRs"
								detail="The full repository view"
								onChange={(other) => setFilter({ other })}
							/>
						</Menu.Group>
						{repos.length > 1 && (
							<>
								<Menu.Separator />
								<Menu.Group>
									<Menu.GroupLabel>Repository</Menu.GroupLabel>
									<SelectionItem
										label="All repositories"
										selected={filter.repo === "all"}
										onClick={() => setFilter({ repo: "all" })}
									/>
									{repos.map((repo) => (
										<SelectionItem
											key={repo}
											label={repo}
											selected={filter.repo === repo}
											onClick={() => setFilter({ repo })}
										/>
									))}
								</Menu.Group>
							</>
						)}
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>Session</Menu.GroupLabel>
							<SelectionItem
								label="All pull requests"
								selected={filter.session === "all"}
								onClick={() => setFilter({ session: "all" })}
							/>
							<SelectionItem
								label="Have session"
								selected={filter.session === "with"}
								onClick={() => setFilter({ session: "with" })}
							/>
							<SelectionItem
								label="No session"
								selected={filter.session === "without"}
								onClick={() => setFilter({ session: "without" })}
							/>
						</Menu.Group>
					</Menu.Popup>
				</Menu.Root>
			</div>

			{open && (
				<div className="sidebar-independent-scroll mt-1">
					{GROUPS.map((group) => {
						const items = byBucket.get(group.key) || [];
						if (items.length === 0) return null;
						const groupIsOpen = groupOpen(group.key);
						return (
							<div className="sidebar-status-group" key={group.key}>
								<button
									className="sidebar-group-header"
									onClick={() => onToggleGroup(group.key)}
								>
									<GroupIcon bucket={group.key} />
									<span className="sidebar-group-name">{group.label}</span>
									<span className="sidebar-group-count">{items.length}</span>
									<IconChevronDown
										className="sidebar-group-chevron"
										size={20}
										style={{
											transform: groupIsOpen ? "none" : "rotate(-90deg)",
										}}
									/>
								</button>
								{groupIsOpen &&
									items.map((item) => (
										<ReviewRow
											key={item.pr.url}
											item={item}
											selected={
												(item.sessionId != null &&
													item.sessionId === selectedReviewId) ||
												(selectedPr?.repo === item.pr.repo &&
													selectedPr.branch === item.pr.branch) ||
												(!!selectedWorkspace &&
													(selectedWorkspace.repo || "tella-fusion") ===
														item.pr.repo &&
													(selectedWorkspace.prNumber === item.pr.number ||
														selectedWorkspace.branch === item.pr.branch))
											}
											onOpen={() => onOpenItem(item)}
											onClose={() => void closePr(item)}
											closing={closingUrls.has(item.pr.url)}
										/>
									))}
							</div>
						);
					})}
					{visible.length === 0 && (
						<div className="px-6 py-3 text-xs text-faint">
							No pull requests in these filters.
						</div>
					)}
					{closeError && (
						<div className="px-6 py-2 text-xs text-red">{closeError}</div>
					)}
				</div>
			)}
		</div>
	);
}

function FilterItem({
	checked,
	label,
	detail,
	onChange,
}: {
	checked: boolean;
	label: string;
	detail: string;
	onChange: (checked: boolean) => void;
}) {
	return (
		<Menu.CheckboxItem checked={checked} onCheckedChange={onChange}>
			<span className="flex size-4 shrink-0 items-center justify-center rounded-xs border border-line-strong text-fg">
				{checked && <IconCheck size={12} />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-fg">{label}</span>
				<span className="block truncate text-[11px] text-faint">{detail}</span>
			</span>
		</Menu.CheckboxItem>
	);
}

function SelectionItem({
	label,
	selected,
	onClick,
}: {
	label: string;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<Menu.Item onClick={onClick}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				{selected && <IconCheck size={13} />}
			</span>
			<span className="truncate">{label}</span>
		</Menu.Item>
	);
}

function ReviewRow({
	item,
	selected,
	onOpen,
	onClose,
	closing,
}: {
	item: ReviewQueueItem;
	selected: boolean;
	onOpen: () => void;
	onClose: () => void;
	closing: boolean;
}) {
	const status = rowStatus(item);
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<button
						type="button"
						className={`sidebar-item sidebar-item--twoline${selected ? " sidebar-item-selected" : ""}`}
						onClick={onOpen}
						title={item.pr.title}
					/>
				}
			>
			<span className="sidebar-item-top">
				<RowIcon bucket={item.bucket} />
				<span className="sidebar-item-title">{item.pr.title}</span>
			</span>
			<span className="sidebar-item-meta">
				<span className="truncate text-dim">{item.pr.author}</span>
				<span>·</span>
				<Tooltip label={`Updated ${exactDate(item.pr.updatedAt)}`} side="bottom">
					<span
						className="relative z-[1] cursor-text select-text"
						onClick={(event) => event.stopPropagation()}
						onPointerDown={(event) => event.stopPropagation()}
					>
						#{item.pr.number}
					</span>
				</Tooltip>
				<span>·</span>
				<span className="shrink-0">{relativeTime(item.pr.updatedAt)}</span>
				{status && (
					<span className={`shrink-0 ${statusTone(item)}`}>{status}</span>
				)}
			</span>
			</ContextMenu.Trigger>
			<ContextMenu.Popup className="min-w-[220px]">
				<ContextMenu.Item onClick={onOpen}>
					<span className="grow">Open review</span>
				</ContextMenu.Item>
				<ContextMenu.Item
					render={
						<a href={item.pr.url} target="_blank" rel="noopener" />
					}
				>
					<IconArrowUpRight size={18} />
					<span className="grow">Open on {providerFromUrl(item.pr.url).name}</span>
				</ContextMenu.Item>
				<ContextMenu.Separator />
				<ContextMenu.Item
					className="text-red data-[highlighted]:bg-red-soft"
					disabled={closing}
					onClick={onClose}
				>
					<IconX size={18} />
					<span className="grow">{closing ? "Closing…" : "Close pull request…"}</span>
				</ContextMenu.Item>
			</ContextMenu.Popup>
		</ContextMenu.Root>
	);
}
