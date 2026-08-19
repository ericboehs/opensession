import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Workspace, UnifiedSession, WSServerMessage } from "../lib/types";
import { fetchModels, updateWorkspaceApi, type ModelOption } from "../lib/api";
import { Composer } from "./Composer";
import { ConversationPane } from "./ConversationPane";
import { FeedWebPane, refWebPanel } from "./FeedWebPane";
import { SlackChannelPane } from "./SlackChannelPane";
import { MarkdownRepoProvider } from "./MarkdownBody";
import { PrPanel } from "./PrPanel";
import type { PrFocus } from "../lib/pr-focus";
import { RepoTile } from "./RepoTile";
import { WorkspaceInfo } from "./WorkspaceInfo";
import { useCurrentUser } from "./UserPicker";
import { useIsPhone } from "../hooks/useIsPhone";
import { useSidePanel } from "../hooks/useSidePanel";
import { IconSidebarRight } from "./icons";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import {
	PANEL_BODY,
	PANEL_OVERLAY,
	PANEL_SHELL,
} from "../lib/session-panel-classes";
import {
	VIEWER_BRANCH,
	VIEWER_HEADER,
	VIEWER_HEADER_ACTIONS,
	VIEWER_TITLE,
} from "../lib/session-viewer-classes";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { InlineAlert } from "../ui/state";

interface Props {
	workspace: Workspace;
	/** The workspace's live sessions, strip order (empty for a session-less workspace). */
	workspaceSessions: UnifiedSession[];
	/** All sessions — the Review pane matches the PR target against any of them. */
	sessions: UnifiedSession[];
	/** Foregrounded view tab; null = the workspace home (first-session composer). */
	tab: "review" | "conversation" | "video" | null;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	/** `created` is the server's copy of a session the info panel just made
	    (Auto-fix), so the app can open it without a loading placeholder. */
	onOpenSession: (id: string, created?: UnifiedSession | null) => void;
	/** Open another PR in the review panel (stack map layer links). */
	onOpenPr?: (repo: string, branch: string) => void;
	/**
	 * The PR this workspace was opened for, when something named one (a sidebar
	 * PR row, a `repo#123` chip). Carries the workspace it was resolved
	 * against, so an older request can't retarget a workspace opened by other
	 * means. See lib/pr-focus.ts.
	 */
	focusPr?: PrFocus & { workspaceId?: string };
	/** The app's top-bar slot. The header row portals in here, the same slot and
	    the same row a session's header uses, so the chrome doesn't change shape
	    when a workspace has no session yet. */
	topbarEl?: HTMLElement | null;
	/** The app's right-column slot — see the header note; the info panel portals
	    in here so it is a full-height column rather than a box below the tabs. */
	rightPanelEl?: HTMLElement | null;
}

/**
 * Top clearance for a view-tab pane on a phone. Unlike the transcript, these
 * panes don't self-pad for the fixed header + docked tab bar, so their own top
 * chrome (the PR header rows, the ticket title) hid underneath it. Their inner
 * scrollers then clip cleanly at the opaque bar's bottom edge.
 * `--strip-clearance` is only set when the docked bar is shown; the
 * `--pane-header-h` term covers the floating pills when it isn't. Desktop has
 * neither, which is why this is phone-only.
 */
const VIEW_MAIN =
	"phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px))]";

/**
 * The session-less workspace container: what a /workspace/<id> route renders when
 * no session is selected. The tab strip above it (SessionTabs) carries the
 * workspace's sessions + view tabs; this pane renders the foregrounded view tab's
 * content — Review via the same PrPanel canvas the in-session tab uses (session
 * APIs when a session carries the PR, repo+branch preview APIs otherwise) — or the
 * workspace home: a composer that starts the first session. PR-backed workspaces
 * start that session on the PR's head branch (fromPr); ticket workspaces inherit
 * plainThreadId server-side from the workspace record.
 */
export function WorkspacePane({
	workspace,
	workspaceSessions,
	sessions,
	tab,
	connected,
	send,
	addHandler,
	onOpenSession,
	onOpenPr,
	focusPr,
	topbarEl,
	rightPanelEl,
}: Props) {
	const draftKey = `workspace-home:${workspace.id}`;
	// Seed from the local (this-browser) draft first: it's the freshest thing
	// typed here. Fall back to the server's parked draft (typed on
	// another device, or by whoever saved it from the New Session composer).
	const [prompt, setPrompt] = useState(() => {
		const local = loadDraft(draftKey).text;
		return local || workspace.draft?.text || "";
	});
	const currentUser = useCurrentUser();
	// Only a workspace the server already knows has a draft gets autosaved back
	// to it. An ordinary sessionless workspace (no draft yet) must not have
	// one invented for it just because its composer has text.
	const hasServerDraft = !!workspace.draft;
	const draftAutoName = workspace.draft?.autoName;
	const promptRef = useRef(prompt);
	promptRef.current = prompt;
	const currentUserRef = useRef(currentUser);
	currentUserRef.current = currentUser;
	const serverDraftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pushServerDraft = React.useCallback(
		(text: string) => {
			void updateWorkspaceApi(workspace.id, {
				draft: {
					text,
					updatedAt: new Date().toISOString(),
					by: currentUserRef.current,
					autoName: draftAutoName,
				},
				// Autosave must never block typing. A flaky connection just means
				// the next keystroke's debounce tries again.
			}).catch(() => {});
		},
		[workspace.id, draftAutoName],
	);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
		if (!hasServerDraft) return;
		clearTimeout(serverDraftTimer.current);
		serverDraftTimer.current = setTimeout(() => pushServerDraft(prompt), 800);
		return () => clearTimeout(serverDraftTimer.current);
	}, [draftKey, prompt, hasServerDraft, pushServerDraft]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// A debounced write in flight when the pane unmounts (navigating away)
	// would otherwise be dropped entirely. Flush it instead of losing the
	// last few keystrokes. Not when a session start is what unmounted the
	// pane, though: the server consumed the draft at create, and a flush
	// would park the just-sent prompt back on the workspace as a stale draft.
	const hasServerDraftRef = useRef(hasServerDraft);
	hasServerDraftRef.current = hasServerDraft;
	useEffect(() => {
		return () => {
			if (serverDraftTimer.current) {
				clearTimeout(serverDraftTimer.current);
				if (hasServerDraftRef.current && !startingRef.current)
					pushServerDraft(promptRef.current);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const isPhone = useIsPhone();
	const sidePanel = useSidePanel();

	useEffect(() => {
		const load = () => fetchModels(workspace.id)
			.then(async (m) => {
				setModels(m.models);
				setDefaultModel(m.default);
				// Preselect this person's own default model and engine (Settings →
				// Preferences); "" keeps the workspace default.
				const preselect = await resolveNewSessionModel(m);
				if (preselect) setModel((current) => current || preselect);
			})
			.catch(() => {});
		void load();
		window.addEventListener("opensession:workspaces-changed", load);
		return () => window.removeEventListener("opensession:workspaces-changed", load);
	}, [workspace.id]);

	// Success navigates away on session_created (App handles it); on failure the
	// `starting` lock would stick forever — reset on server error or timeout
	// (same pattern as the PR/support previews).
	useEffect(() => {
		return addHandler((msg) => {
			if (msg.type === "error" && startingRef.current) {
				clearTimeout(startTimer.current);
				startingRef.current = false;
				setStarting(false);
				setStartError(msg.message || "Failed to start the session.");
			} else if (msg.type === "session_created" && startingRef.current) {
				clearDraft(draftKey);
				// Cancel any in-flight draft autosave too: the server consumed
				// the workspace draft at create, and a late debounce landing
				// after that clear would resurrect it as a stale draft.
				clearTimeout(serverDraftTimer.current);
				serverDraftTimer.current = undefined;
			}
		});
	}, [addHandler, draftKey]);
	useEffect(() => () => clearTimeout(startTimer.current), []);

	// The Review pane's target: the workspace's own PR branch, rendered through
	// the newest session that carries it (session PR APIs) or the repo+branch
	// preview APIs when none does — the PrQueuePreview pattern, workspace-scoped.
	//
	// A named PR wins over the workspace's own branch. This pane is what a
	// workspace shows before its sessions have loaded, which is most of the
	// time a PR link is followed cold — and the workspace's branch is the
	// first PR filed here, not the one the link was for.
	const focusedBranch =
		focusPr?.workspaceId === workspace.id ? focusPr?.branch : undefined;
	const reviewTarget = focusedBranch
		? {
				repo: focusPr?.repo || workspace.repo || "repository",
				branch: focusedBranch,
			}
		: workspace.branch
			? { repo: workspace.repo || "repository", branch: workspace.branch }
			: null;
	const reviewSession = useMemo(() => {
		if (!reviewTarget) return null;
		return (
			[...sessions]
				.filter(
					(s) =>
						(s.repo || "repository") === reviewTarget.repo &&
						s.branch === reviewTarget.branch,
				)
				.sort((a, b) =>
					(b.lastActivity || "").localeCompare(a.lastActivity || ""),
				)[0] || null
		);
	}, [sessions, reviewTarget?.repo, reviewTarget?.branch]);

	function handleStart() {
		const q = prompt.trim();
		if (!q || starting || !connected) return;
		setStarting(true);
		startingRef.current = true;
		setStartError(null);
		clearTimeout(startTimer.current);
		startTimer.current = setTimeout(() => {
			if (!startingRef.current) return;
			startingRef.current = false;
			setStarting(false);
			setStartError(
				`${AGENT_NAME} didn't respond. Check your connection and try again.`,
			);
		}, 15_000);
		// PR-backed workspaces start on the PR's existing head branch (fromPr:
		// isolated worktree even on shared-checkout repos); ticket/plain
		// workspaces start ask-style, and the server links plainThreadId from the
		// workspace record and injects the ticket context. Feed-item workspaces
		// (externalRefs, no repo, such as a Tella video) start in scratch mode:
		// repo-less scratch dir, write+bash allowed, MCP as usual.
		send({
			type: "create_session",
			mode: workspace.branch
				? "code"
				: workspace.externalRefs?.length && !workspace.repo
					? "scratch"
					: "ask",
			branch: workspace.branch || "",
			...(workspace.repo ? { repo: workspace.repo } : {}),
			...(workspace.branch ? { fromPr: true } : {}),
			workspaceId: workspace.id,
			prompt: q,
			user: currentUser,
			...(model ? { model } : {}),
		});
		// App navigates into the session on session_created.
	}

	// The session-scoped APIs the panel's PR / diff / git rows read through. A
	// session-less workspace has none, and the panel simply shows what the
	// workspace record and its overview already say.
	const anchorSession = workspaceSessions[0] ?? reviewSession;

	// The workspace's right column: the same panel a session shows, with the
	// same Info block in it. A workspace is a first-class surface, so the chrome
	// around it doesn't change when the last session goes — only what the pane
	// beside it holds.
	const infoPanel = !isPhone && sidePanel.open && (
		<>
			<div className={PANEL_OVERLAY} onClick={() => sidePanel.setOpen(false)} />
			<aside className={PANEL_SHELL} style={sidePanel.style}>
				{sidePanel.resizeHandle}
				<div className={PANEL_BODY}>
					<div className="px-1">
						<WorkspaceInfo
							sessionId={anchorSession?.id || ""}
							workspaceId={workspace.id}
							sessions={workspaceSessions.map((s) => ({
								id: s.id,
								title: s.title,
								createdAt: s.createdAt || "",
								startedBy: s.startedBy,
							}))}
							repo={workspace.repo || undefined}
							prState={anchorSession?.prState}
							send={connected ? send : undefined}
							onOpenSession={onOpenSession}
							liveMediaCount={0}
						/>
					</div>
				</div>
			</aside>
		</>
	);

	// The header row, in the app's own top-bar slot so it lands exactly where a
	// session's header does — beside the pane, not across the panel.
	const header = !isPhone && (
		<div className={VIEWER_HEADER}>
			<div className={VIEWER_TITLE}>
				{workspace.repo && <RepoTile name={workspace.repo} />}
				<span className={VIEWER_BRANCH}>{workspace.name}</span>
			</div>
			<div className={VIEWER_HEADER_ACTIONS}>
				<Tooltip label="Toggle side panel">
					<Button
						variant="ghost"
						size="md"
						className="rounded-control text-dim hover:bg-hover hover:text-fg"
						onClick={() => sidePanel.setOpen(!sidePanel.open)}
						aria-label="Toggle side panel"
						icon={<IconSidebarRight size={22} />}
					/>
				</Tooltip>
			</div>
		</div>
	);

	// Everything on this pane — the PR body, review comments, the info panel —
	// is about this workspace's repo, so a `#5528` written in any of it means a
	// PR there (markdown.ts). Both portals sit inside the provider: a React
	// portal moves the DOM node, not the context.
	const withPanel = (main: React.ReactNode) => (
		<MarkdownRepoProvider repo={workspace.repo}>
			{topbarEl && header ? createPortal(header, topbarEl) : null}
			<div className="flex h-full min-h-0">
				<div className="flex-1 min-w-0 min-h-0">{main}</div>
			</div>
			{rightPanelEl && infoPanel ? createPortal(infoPanel, rightPanelEl) : null}
		</MarkdownRepoProvider>
	);

	if (tab === "review" && reviewTarget) {
		return withPanel(
			<div className={`${VIEW_MAIN} h-full min-h-0 bg-surface`}>
				<PrPanel
					onOpenPr={onOpenPr}
					key={`${reviewTarget.repo}:${reviewTarget.branch}`}
					sessionId={reviewSession?.id || ""}
					previewTarget={reviewSession ? undefined : reviewTarget}
					send={send}
					addHandler={addHandler}
					sessions={sessions}
					onOpenSessionById={onOpenSession}
					onOpenSession={
						reviewSession ? () => onOpenSession(reviewSession.id) : undefined
					}
					walkthrough={reviewSession?.walkthrough}
				/>
			</div>,
		);
	}

	if (tab === "conversation" && workspace.plainThreadId) {
		return withPanel(
			<div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
				<ConversationPane
					threadId={workspace.plainThreadId}
					onOpenSession={onOpenSession}
					hideTriage={workspaceSessions.length > 0}
				/>
			</div>,
		);
	}

	// The feed web panel (Tella video embed, … — the feeds design) on the
	// session-less workspace route.
	const webRef = (workspace.externalRefs || []).find((r) => refWebPanel(r));
	const webPanel = webRef ? refWebPanel(webRef) : null;
	if (tab === "video" && webPanel) {
		return withPanel(
			<div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
				{webPanel.component === "slack-channel" ? (
					<SlackChannelPane channelId={webPanel.refId} />
				) : (
					<FeedWebPane
						panel={webPanel}
						title={webRef?.title || workspace.name}
					/>
				)}
			</div>,
		);
	}

	// Workspace home: normally only reachable session-less (with sessions, App lands
	// in the first session) — a composer that starts the workspace's first session.
	//
	// The canvas above the composer stays blank, the same way a fresh session's
	// transcript does. This IS a session — it has its own tab in the strip — so
	// it doesn't narrate that there are no sessions yet, and the header row and
	// info panel already say which workspace it belongs to.
	return withPanel(
		<div className={`${VIEW_MAIN} flex flex-col h-full min-h-0`}>
			<div className="flex-1 min-h-0 overflow-y-auto" />
			<div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={starting ? "Starting…" : "Start a session in this workspace…"}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start a session in this workspace (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this session"
				/>
				{startError && <InlineAlert className="mt-2.5">{startError}</InlineAlert>}
			</div>
		</div>,
	);
}
