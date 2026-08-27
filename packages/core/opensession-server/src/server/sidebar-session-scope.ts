import { listAutomations } from "./automations";
import { defaultRepo } from "./config";
import { getHides } from "./hides";
import { getLanes } from "./lanes";
import { listMentions } from "./mentions";
import { getPins } from "./pins";
import { getSnoozes } from "./snoozes";
import { userMatchesAny } from "./shared/user-mappings";
import type { UnifiedSession } from "./types";
import { getWorkspace, type Workspace } from "./workspaces";

export interface SidebarSessionScope {
	user: string;
	person: string;
	repo: string;
	autoCreated: "show" | "hide";
	selectedSessionId?: string;
	selectedWorkspaceId?: string;
}

interface AutomationAudience {
	owner?: string;
	repo?: string;
	workspaceRepo?: string;
}

export interface SidebarScopeSession extends UnifiedSession {
	waitingForInput?: boolean;
	queuedCount?: number;
}

export interface SidebarSessionScopeContext {
	pins: Set<string>;
	lanes: Set<string>;
	snoozes: Set<string>;
	hides: Set<string>;
	mentions: Set<string>;
	workspaces: Map<string, Pick<Workspace, "createdBy" | "repo">>;
	automations: Map<string, AutomationAudience>;
	defaultRepo: string;
}

const MAX_QUERY_VALUE_LENGTH = 256;
export const TEAM_ACTIVITY_RECENT_MS = 15 * 60 * 1000;

function cleanQueryValue(value: string | null): string | undefined {
	const clean = value?.trim();
	return clean && clean.length <= MAX_QUERY_VALUE_LENGTH ? clean : undefined;
}

/** Parse the opt-in sidebar projection. The ordinary endpoint stays unchanged. */
export function parseSidebarSessionScope(
	params: URLSearchParams,
	user: string,
): SidebarSessionScope | null {
	if (params.get("view") !== "sidebar") return null;
	const cleanUser = user.trim();
	if (!cleanUser) return null;
	const autoCreated = params.get("autoCreated") === "show" ? "show" : "hide";
	return {
		user: cleanUser,
		person: cleanQueryValue(params.get("person")) || "me",
		repo: cleanQueryValue(params.get("repo")) || "all",
		autoCreated,
		...(cleanQueryValue(params.get("session"))
			? { selectedSessionId: cleanQueryValue(params.get("session")) }
			: {}),
		...(cleanQueryValue(params.get("workspace"))
			? { selectedWorkspaceId: cleanQueryValue(params.get("workspace")) }
			: {}),
	};
}

export function sidebarSessionScopeKey(scope: SidebarSessionScope): string {
	return [
		"sidebar",
		scope.user.toLowerCase(),
		scope.person.toLowerCase(),
		scope.repo,
		scope.autoCreated,
		scope.selectedSessionId || "",
		scope.selectedWorkspaceId || "",
	].join("\u0000");
}

/** Load the per-person overlays that decide which sidebar rows exist. */
export function loadSidebarSessionScopeContext(
	scope: SidebarSessionScope,
	sessions: readonly UnifiedSession[],
): SidebarSessionScopeContext {
	const workspaces = new Map<string, Pick<Workspace, "createdBy" | "repo">>();
	for (const session of sessions) {
		if (!session.workspaceId || workspaces.has(session.workspaceId)) continue;
		const workspace = getWorkspace(session.workspaceId);
		if (workspace)
			workspaces.set(session.workspaceId, {
				createdBy: workspace.createdBy,
				repo: workspace.repo,
			});
	}

	const automations = new Map<string, AutomationAudience>();
	try {
		for (const automation of listAutomations()) {
			const workspaceRepo = automation.workspaceId
				? getWorkspace(automation.workspaceId)?.repo
				: undefined;
			const audience = {
				owner: automation.owner,
				repo: automation.repo,
				workspaceRepo,
			};
			automations.set(automation.id, audience);
			automations.set(automation.name, audience);
		}
	} catch {
		// A missing or temporarily unreadable automation store should not empty
		// the person's ordinary sidebar rows.
	}

	return {
		pins: new Set(getPins(scope.user)),
		lanes: new Set(Object.keys(getLanes(scope.user))),
		snoozes: new Set(Object.keys(getSnoozes(scope.user))),
		hides: new Set(Object.keys(getHides(scope.user))),
		mentions: new Set(listMentions(scope.user).map((mention) => mention.sessionId)),
		workspaces,
		automations,
		defaultRepo: defaultRepo().id,
	};
}

function personMatches(value: string | null | undefined, person: string): boolean {
	return !!value && userMatchesAny(value, [person]);
}

function sessionGroupKey(session: UnifiedSession): string {
	if (session.workspaceId) return `workspace:${session.workspaceId}`;
	if (session.worktreeDir?.includes("/worktrees/"))
		return `wt:${session.worktreeDir}`;
	return session.id;
}

function sessionMatchesRepo(
	session: UnifiedSession,
	scope: SidebarSessionScope,
	context: SidebarSessionScopeContext,
): boolean {
	if (scope.repo === "all") return true;
	const workspaceRepo = session.workspaceId
		? context.workspaces.get(session.workspaceId)?.repo
		: undefined;
	if (workspaceRepo === scope.repo) return true;
	if (session.repoLess) return false;
	return (session.repo || context.defaultRepo) === scope.repo;
}

function automationMatchesScope(
	session: UnifiedSession,
	scope: SidebarSessionScope,
	context: SidebarSessionScopeContext,
): boolean {
	const automation = context.automations.get(session.automation || "") || {};
	if (scope.repo !== "all") {
		const repo = automation.repo || context.defaultRepo;
		if (repo !== scope.repo && automation.workspaceRepo !== scope.repo) return false;
	}
	if (scope.person === "everyone") return true;
	if (scope.person === "unassigned") return false;
	const person = scope.person === "me" ? scope.user : scope.person;
	if (scope.person === "me" && person.toLowerCase() === "anonymous") return true;
	const owner = automation.owner?.trim();
	if (!owner) return person.toLowerCase() === "agent";
	const a = owner.toLowerCase();
	const b = person.toLowerCase();
	return a === b || a.startsWith(b) || b.startsWith(a);
}

function requestInvolvesPerson(
	session: UnifiedSession,
	person: string,
): boolean {
	const request = session.reviewRequest;
	if (
		request &&
		(personMatches(request.by, person) ||
			personMatches(request.to, person) ||
			(request.recipients || []).some((recipient) =>
				personMatches(recipient, person),
			))
	)
		return true;
	return (session.prReviewRequested || []).some((reviewer) =>
		personMatches(reviewer, person),
	);
}

function isAutoCreatedGroup(sessions: readonly UnifiedSession[]): boolean {
	const ordinary = sessions.filter((session) => !session.automation);
	return (
		ordinary.length > 0 &&
		ordinary.every((session) =>
			[session.createdBy, session.startedBy].some(
				(person) => person?.trim().toLowerCase() === "automation",
			),
		)
	);
}

function groupOwnsSelection(
	key: string,
	sessions: readonly UnifiedSession[],
	scope: SidebarSessionScope,
): boolean {
	if (
		scope.selectedWorkspaceId &&
		key === `workspace:${scope.selectedWorkspaceId}`
	)
		return true;
	if (!scope.selectedSessionId) return false;
	return sessions.some(
		(session) =>
			session.id === scope.selectedSessionId ||
			session.aliasIds?.includes(scope.selectedSessionId!),
	);
}

function groupHasOverlay(
	key: string,
	sessions: readonly UnifiedSession[],
	context: SidebarSessionScopeContext,
): boolean {
	if (
		context.pins.has(key) ||
		context.snoozes.has(key) ||
		sessions.some((session) =>
			[session.id, ...(session.aliasIds || [])].some(
				(id) => context.pins.has(id) || context.lanes.has(id),
			),
		)
	)
		return true;
	return sessions.some((session) => context.mentions.has(session.id));
}

function groupNeedsAttention(sessions: readonly SidebarScopeSession[]): boolean {
	return sessions.some(
		(session) =>
			!!session.waitingForInput ||
			(!!session.lastRunError && !session.isRunning),
	);
}

/** The global team-activity window appended to every scoped sidebar response. */
export function sessionIsRecentTeamActivity(
	session: UnifiedSession,
	nowMs: number,
): boolean {
	if (session.desk) return false;
	if (session.isRunning) return true;
	const ran = !!(
		session.claudeSessionId ||
		session.codexThreadId ||
		session.piSessionId
	);
	if (!ran) return false;
	const lastActivity = Date.parse(session.lastActivity || "");
	return (
		Number.isFinite(lastActivity) &&
		lastActivity >= nowMs - TEAM_ACTIVITY_RECENT_MS
	);
}

/**
 * Keep exactly the live inventory needed to derive the current sidebar lens.
 * Every retained workspace stays whole so its status and tab strip remain
 * correct, while unrelated teammates' work never crosses the network.
 */
export function scopeSessionsForSidebar<T extends SidebarScopeSession>(
	sessions: T[],
	scope: SidebarSessionScope,
	context: SidebarSessionScopeContext,
	nowMs = Date.now(),
): T[] {
	const selectedIds = new Set<string>();
	const selectedGroupKeys = new Set<string>();
	if (scope.selectedWorkspaceId)
		selectedGroupKeys.add(`workspace:${scope.selectedWorkspaceId}`);
	if (scope.selectedSessionId) {
		const selected = sessions.find(
			(session) =>
				session.id === scope.selectedSessionId ||
				session.aliasIds?.includes(scope.selectedSessionId!),
		);
		if (selected) selectedGroupKeys.add(sessionGroupKey(selected));
	}
	for (const session of sessions)
		if (selectedGroupKeys.has(sessionGroupKey(session))) selectedIds.add(session.id);
	// Active workers can live in temporary child workspaces. Keep their chain
	// when the selected workspace or parent session is open.
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const session of sessions) {
			if (
				session.parentSessionId &&
				selectedIds.has(session.parentSessionId) &&
				(session.isRunning || session.waitingForInput || (session.queuedCount || 0) > 0) &&
				!selectedIds.has(session.id)
			) {
				selectedIds.add(session.id);
				expanded = true;
			}
		}
	}

	const ordinary: T[] = [];
	const automationRuns: T[] = [];
	for (const session of sessions) {
		const selected = selectedIds.has(session.id);
		const claimed = context.lanes.has(session.id) || !!session.manualStatus;
		if (session.automation && !claimed && !selected) {
			if (automationMatchesScope(session, scope, context))
				automationRuns.push(session);
			continue;
		}
		if (session.desk && !selected) continue;
		if (
			session.spawnedBy &&
			!selected &&
			!claimed &&
			!groupNeedsAttention([session])
		)
			continue;
		ordinary.push(session);
	}

	const groups = new Map<string, T[]>();
	for (const session of ordinary) {
		const selected = selectedIds.has(session.id);
		if (!selected && !sessionMatchesRepo(session, scope, context)) continue;
		if (
			!selected &&
			scope.person !== "me" &&
			scope.person !== "everyone" &&
			scope.person !== "unassigned" &&
			!session.automation &&
			!personMatches(session.startedBy, scope.person)
		)
			continue;
		const key = sessionGroupKey(session);
		const rows = groups.get(key) || [];
		rows.push(session);
		groups.set(key, rows);
	}

	const keep = new Set<T>(automationRuns);
	const focus = scope.person === "me" ? scope.user : scope.person;
	for (const [key, rows] of groups) {
		const selected = groupOwnsSelection(key, rows, scope) || rows.some((row) => selectedIds.has(row.id));
		const overlay = scope.person === "me" && groupHasOverlay(key, rows, context);
		const review =
			scope.person === "me" && rows.some((row) => requestInvolvesPerson(row, scope.user));
		const workspaceOwner = key.startsWith("workspace:")
			? context.workspaces.get(key.slice("workspace:".length))?.createdBy
			: undefined;
		const owned =
			personMatches(workspaceOwner, focus) ||
			rows.some(
				(row) => !row.automation && personMatches(row.startedBy, focus),
			);
		const inLens =
			scope.person === "everyone" ||
			(scope.person === "unassigned"
				? rows.every(
						(row) =>
							!row.isRunning &&
							!row.waitingForInput &&
							!row.lastRunError &&
							!context.lanes.has(row.id) &&
							!row.manualStatus,
					)
				: owned);
		const autoCreated = isAutoCreatedGroup(rows);
		const visible =
			selected ||
			overlay ||
			review ||
			(inLens && (scope.autoCreated === "show" || !autoCreated));
		if (!visible) continue;
		if (
			context.hides.has(key) &&
			!selected &&
			!groupNeedsAttention(rows)
		)
			continue;
		for (const row of rows) keep.add(row);
	}

	// The People section is a global live-team view, even while the workspace
	// list above is narrowed to Me, one repo, or another person. Keep only the
	// active window here; the frontend applies the directory/Agent ownership
	// rules and drops each idle row at the exact fifteen-minute boundary.
	for (const session of sessions)
		if (sessionIsRecentTeamActivity(session, nowMs)) keep.add(session);

	return sessions.filter((session) => keep.has(session));
}
