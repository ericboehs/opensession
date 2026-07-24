import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Project, UnifiedSession, WSServerMessage } from "../lib/types";
import { fetchModels, type ModelOption } from "../lib/api";
import { Composer } from "./Composer";
import { ConversationPane } from "./ConversationPane";
import { PrPanel } from "./PrPanel";
import { useCurrentUser } from "./UserPicker";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";

interface Props {
	workspace: Project;
	/** The workspace's live chats, strip order (empty for a chat-less workspace). */
	chats: UnifiedSession[];
	/** All sessions — the Review pane matches the PR target against any of them. */
	sessions: UnifiedSession[];
	/** Foregrounded view tab; null = the workspace home (first-chat composer). */
	tab: "review" | "conversation" | null;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	onOpenSession: (id: string) => void;
}

/**
 * The chat-less workspace container: what a /workspace/<id> route renders when
 * no chat is selected. The tab strip above it (SessionTabs) carries the
 * workspace's chats + view tabs; this pane renders the foregrounded view tab's
 * content — Review via the same PrPanel canvas the in-session tab uses (session
 * APIs when a chat carries the PR, repo+branch preview APIs otherwise) — or the
 * workspace home: a composer that starts the first chat. PR-backed workspaces
 * start that chat on the PR's head branch (fromPr); ticket workspaces inherit
 * plainThreadId server-side from the workspace record.
 */
export function WorkspacePane({
	workspace,
	chats,
	sessions,
	tab,
	connected,
	send,
	addHandler,
	onOpenSession,
}: Props) {
	const draftKey = `workspace-home:${workspace.id}`;
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();

	useEffect(() => {
		fetchModels()
			.then((m) => {
				setModels(m.models);
				setDefaultModel(m.default);
			})
			.catch(() => {});
	}, []);

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
			}
		});
	}, [addHandler, draftKey]);
	useEffect(() => () => clearTimeout(startTimer.current), []);

	// The Review pane's target: the workspace's own PR branch, rendered through
	// the newest session that carries it (session PR APIs) or the repo+branch
	// preview APIs when none does — the PrQueuePreview pattern, workspace-scoped.
	const reviewTarget = workspace.branch
		? { repo: workspace.repo || "tella-fusion", branch: workspace.branch }
		: null;
	const reviewSession = useMemo(() => {
		if (!reviewTarget) return null;
		return (
			[...sessions]
				.filter(
					(s) =>
						(s.repo || "tella-fusion") === reviewTarget.repo &&
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
		// workspaces start ask-style — the server links plainThreadId from the
		// workspace record and injects the ticket context.
		send({
			type: "create_session",
			mode: workspace.branch ? "code" : "ask",
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

	if (tab === "review" && reviewTarget) {
		return (
			<div className="h-full min-h-0 bg-surface">
				<PrPanel
					key={`${reviewTarget.repo}:${reviewTarget.branch}`}
					sessionId={reviewSession?.id || ""}
					previewTarget={reviewSession ? undefined : reviewTarget}
					reviewCanvas
					onOpenSession={
						reviewSession ? () => onOpenSession(reviewSession.id) : undefined
					}
					walkthrough={reviewSession?.walkthrough}
				/>
			</div>
		);
	}

	if (tab === "conversation" && workspace.plainThreadId) {
		return (
			<div className="flex flex-col h-full min-h-0">
				<ConversationPane
					threadId={workspace.plainThreadId}
					onOpenSession={onOpenSession}
					hideTriage={chats.length > 0}
				/>
			</div>
		);
	}

	// Workspace home: normally only reachable chat-less (with chats, App lands
	// in the first chat) — a composer that starts the workspace's first chat.
	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="w-full max-w-[760px] mx-auto px-5 py-6">
					<div className="text-fg font-semibold text-[18px]">
						{workspace.name}
					</div>
					<div className="text-dim text-[12.5px] mt-1 flex items-center gap-2 flex-wrap">
						{workspace.repo && <span>{workspace.repo}</span>}
						{workspace.branch && (
							<span className="font-mono text-[12px]">{workspace.branch}</span>
						)}
					</div>
					{chats.length === 0 && (
						<div className="text-dim text-[13px] mt-5">
							No chats in this workspace yet — start one below
							{workspace.branch ? " on the PR's branch" : ""}.
						</div>
					)}
				</div>
			</div>
			<div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={starting ? "Starting…" : "Start a chat in this workspace…"}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start a chat in this workspace (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this chat"
				/>
				{startError && <div className="ask-error">{startError}</div>}
			</div>
		</div>
	);
}
