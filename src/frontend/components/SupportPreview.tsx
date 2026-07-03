import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlainThread, WSServerMessage } from "../lib/types";
import {
	fetchModels,
	fetchPlainThreadById,
	startPlainTriageApi,
	type ModelOption,
} from "../lib/api";
import { Composer } from "./Composer";
import { useCurrentUser } from "./UserPicker";
import {
	PlainEntryRow,
	plainThreadUrl,
	STATUS_LABEL,
} from "./PlainThreadPanel";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";

interface Props {
	/** The Plain thread id — the preview's key. */
	threadId: string;
	connected: boolean;
	send: (msg: any) => void;
	addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
	/** Navigate into a session (the triage button resolves to one over HTTP). */
	onOpenSession: (id: string) => void;
}

/**
 * Session-less support-ticket view: what a sidebar Support row opens when no
 * session is linked to the Plain thread yet. Shows the full conversation
 * straight from Plain (no LLM involved), with two ways in: "Triage this
 * ticket" runs the Plain triage automation and lands in its session, and the
 * composer at the bottom creates a fresh linked session on the first message
 * (`create_session` with `plainThreadId`) — App navigates into it on
 * `session_created` exactly like the PR preview.
 */
export function SupportPreview({
	threadId,
	connected,
	send,
	addHandler,
	onOpenSession,
}: Props) {
	const draftKey = `support-preview:${threadId}`;
	const [thread, setThread] = useState<PlainThread | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [prompt, setPrompt] = useState(() => loadDraft(draftKey).text);
	useEffect(() => {
		saveDraft(draftKey, { text: prompt });
	}, [draftKey, prompt]);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const startingRef = useRef(false);
	const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [triaging, setTriaging] = useState(false);
	const [triageError, setTriageError] = useState<string | null>(null);
	const aliveRef = useRef(true);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [defaultModel, setDefaultModel] = useState("");
	const [model, setModel] = useState(""); // "" = default
	const currentUser = useCurrentUser();

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	// Load on mount / thread change, then poll — the customer can reply while
	// the ticket is being read and there's no live push for Plain.
	const load = useCallback(() => {
		return fetchPlainThreadById(threadId)
			.then((t) => {
				if (!aliveRef.current) return;
				setThread(t);
				setError(null);
			})
			.catch((e) => {
				if (aliveRef.current) setError(e?.message || "Failed to load");
			})
			.finally(() => {
				if (aliveRef.current) setLoading(false);
			});
	}, [threadId]);
	useEffect(() => {
		setLoading(true);
		setThread(null);
		setError(null);
		load();
		const poll = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			load();
		}, 20000);
		return () => clearInterval(poll);
	}, [load]);

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
	// (same pattern as the PR preview).
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
			setStartError("Michael didn't respond — check the connection and try again.");
		}, 15_000);
		const customer =
			thread?.customer?.name || thread?.customer?.email || "customer";
		send({
			type: "create_session",
			mode: "ask",
			branch: "",
			prompt: q,
			user: currentUser,
			plainThreadId: threadId,
			// Name the workspace after the ticket so the sidebar row reads as the
			// ticket (never auto-renamed — name is given).
			createWorkspace: {
				name: `Support: ${thread?.title || customer}`.slice(0, 80),
			},
			...(model ? { model } : {}),
		});
		// App navigates into the session on session_created
	}

	// The triage automation reuses a live session for this thread when one
	// exists, else boots a fresh run — that takes tens of seconds, so keep the
	// button in a visible in-progress state the whole way.
	async function handleTriage() {
		if (triaging) return;
		setTriaging(true);
		setTriageError(null);
		try {
			const sessionId = await startPlainTriageApi(threadId);
			if (aliveRef.current) onOpenSession(sessionId);
		} catch (e: any) {
			if (aliveRef.current)
				setTriageError(e?.message || "Failed to start the triage run.");
		} finally {
			if (aliveRef.current) setTriaging(false);
		}
	}

	const status = thread?.status;
	const customerLabel =
		thread?.customer?.name || thread?.customer?.email || "Unknown customer";

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="w-full max-w-[760px] mx-auto px-5 py-6">
					{loading && !thread ? (
						<div className="panel-placeholder">Loading ticket…</div>
					) : error && !thread ? (
						<div className="panel-placeholder">
							Couldn't load this Plain thread: {error}
						</div>
					) : (
						<>
							<div className="flex items-center gap-2.5 min-w-0">
								<span
									className="text-fg font-semibold text-[15px] truncate"
									title={thread?.customer?.email || ""}
								>
									{customerLabel}
								</span>
								{thread?.customer?.name && thread?.customer?.email && (
									<span className="text-faint text-[12px] truncate">
										{thread.customer.email}
									</span>
								)}
								{status && (
									<span
										className={`plain-status plain-status-${status.toLowerCase()}`}
									>
										{STATUS_LABEL[status] || status}
									</span>
								)}
								<a
									className="plain-open ml-auto shrink-0"
									href={plainThreadUrl(threadId)}
									target="_blank"
									rel="noreferrer"
									title="Open this thread in Plain"
								>
									Open in Plain ↗
								</a>
							</div>
							{thread?.title && (
								<div className="text-fg font-semibold text-[18px] mt-2">
									{thread.title}
								</div>
							)}

							{/* The "do you want to triage this?" affordance: one click runs
							    the Plain triage automation and lands in its session. */}
							<div className="flex items-center gap-3 flex-wrap mt-4 p-3 rounded-lg border border-line bg-panel">
								<div className="min-w-0 flex-1">
									<div className="text-fg font-semibold text-[13px]">
										Triage this ticket?
									</div>
									<div className="text-dim text-[12px] mt-0.5">
										Runs the Plain triage automation: investigates, posts an
										internal note, and can open a PR for review.
									</div>
								</div>
								<button
									className="shrink-0 rounded-md bg-accent text-white text-[13px] font-semibold px-3 py-1.5 cursor-pointer border-0 hover:opacity-90 disabled:opacity-50 disabled:cursor-default"
									onClick={handleTriage}
									disabled={triaging}
								>
									{triaging ? "Starting triage… (~30s)" : "Triage this ticket"}
								</button>
								{triageError && (
									<div className="basis-full text-red text-[12px]">
										{triageError}
									</div>
								)}
							</div>

							<div className="flex flex-col gap-3 mt-5">
								{thread && thread.entries.length === 0 ? (
									<div className="plain-loading">
										No messages in this thread yet.
									</div>
								) : (
									thread?.entries.map((e) => (
										<PlainEntryRow key={e.id} entry={e} />
									))
								)}
							</div>
						</>
					)}
				</div>
			</div>

			<div className="w-full max-w-[760px] mx-auto px-5 pb-5 shrink-0">
				<Composer
					value={prompt}
					onChange={setPrompt}
					onSend={handleStart}
					placeholder={
						starting
							? "Starting session on this ticket…"
							: "Start a session on this ticket — investigate, dig into the account, draft a reply…"
					}
					disabled={starting}
					sendDisabled={starting || !connected || !prompt.trim()}
					sendTitle="Start session on this ticket (Enter)"
					models={models}
					defaultModel={defaultModel}
					model={model}
					onModelChange={setModel}
					modelTitle="Model for this session"
				/>
				{startError && <div className="ask-error">{startError}</div>}
			</div>
		</div>
	);
}
