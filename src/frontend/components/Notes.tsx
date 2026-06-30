import React, {
	Suspense,
	lazy,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { marked } from "marked";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
	fetchWikiTree,
	fetchWikiFile,
	searchWikiApi,
	createNoteApi,
	deleteNoteApi,
	promptNoteApi,
	type NoteMeta,
} from "../lib/api";
import type { WSClientMessage, WSServerMessage } from "../lib/types";
import type { MentionKind } from "./NoteEditor";

const NoteEditor = lazy(() => import("./NoteEditor"));

interface WikiNode {
	name: string;
	path: string;
	type: "dir" | "file";
	children?: WikiNode[];
}
interface SearchHit {
	path: string;
	title: string;
	line: number;
	snippet: string;
}

export type NotesSelection =
	| { kind: "note"; id: string }
	| { kind: "doc"; path: string }
	| null;

interface Props {
	sel: NotesSelection;
	notes: NoteMeta[];
	refreshNotes: () => void;
	pinnedNoteIds: Set<string>;
	onTogglePinNote: (id: string) => void;
	onSelectNote: (id: string) => void;
	onSelectDoc: (path: string | null) => void;
	sessions: { id: string; title: string }[];
	onOpenSession: (id: string) => void;
	user: string;
	connected: boolean;
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
}

function flattenPaths(nodes: WikiNode[]): string[] {
	const out: string[] = [];
	const walk = (ns: WikiNode[]) => {
		for (const n of ns) {
			if (n.type === "file") out.push(n.path);
			else if (n.children) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}
function ancestorDirs(docPath: string): string[] {
	const parts = docPath.split("/");
	const dirs: string[] = [];
	for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
	return dirs;
}
/** Copy text without the Clipboard API (insecure-context fallback). */
function fallbackCopy(text: string, onDone: () => void) {
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		if (ok) onDone();
	} catch {}
}

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---\n")) return md;
	const end = md.indexOf("\n---", 4);
	if (end === -1) return md;
	return md.slice(end + 4).replace(/^\n+/, "");
}

function WikiTree({
	paths,
	docPath,
	onOpen,
}: {
	paths: string[];
	docPath: string | null;
	onOpen: (path: string) => void;
}) {
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const { model } = useFileTree({
		paths,
		initialExpandedPaths: docPath ? ancestorDirs(docPath) : [],
		initialSelectedPaths: docPath ? [docPath] : undefined,
		onSelectionChange: (selected) => {
			const p = selected[0] ? String(selected[0]) : null;
			if (p && /\.(md|mdx)$/.test(p)) onOpenRef.current(p);
		},
	});
	return <FileTree model={model} className="wiki-filetree" />;
}

export function Notes({
	sel,
	notes,
	refreshNotes,
	pinnedNoteIds,
	onTogglePinNote,
	onSelectNote,
	onSelectDoc,
	sessions,
	onOpenSession,
	user,
	connected,
	send,
	addHandler,
}: Props) {
	const [tree, setTree] = useState<WikiNode[]>([]);
	const [docContent, setDocContent] = useState<string | null>(null);
	const [loadingDoc, setLoadingDoc] = useState(false);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const [navOpen, setNavOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newTitle, setNewTitle] = useState("");

	const selNoteId = sel?.kind === "note" ? sel.id : null;
	const selDocPath = sel?.kind === "doc" ? sel.path : null;

	useEffect(() => {
		fetchWikiTree()
			.then(setTree)
			.catch(() => {});
	}, []);

	const paths = useMemo(() => flattenPaths(tree), [tree]);

	useEffect(() => {
		const note = selNoteId ? notes.find((n) => n.id === selNoteId) : null;
		document.title = note
			? `${note.title} — Notes — Michael`
			: selDocPath
				? `${selDocPath.split("/").pop()} — Docs — Michael`
				: "Notes — Michael";
		return () => {
			document.title = "Michael — Tella";
		};
	}, [selNoteId, selDocPath, notes]);

	// Load a selected doc (read-only).
	useEffect(() => {
		if (!selDocPath) {
			setDocContent(null);
			return;
		}
		setLoadingDoc(true);
		fetchWikiFile(selDocPath)
			.then((f) => setDocContent(f.content))
			.catch(() => setDocContent("*Document not found.*"))
			.finally(() => setLoadingDoc(false));
	}, [selDocPath]);

	// Debounced doc search.
	useEffect(() => {
		if (query.trim().length < 2) {
			setHits(null);
			return;
		}
		const t = setTimeout(() => {
			searchWikiApi(query)
				.then(setHits)
				.catch(() => {});
		}, 250);
		return () => clearTimeout(t);
	}, [query]);

	const docHtml = useMemo(() => {
		if (!docContent) return "";
		try {
			return marked.parse(stripFrontmatter(docContent), {
				async: false,
			}) as string;
		} catch {
			return `<pre>${docContent}</pre>`;
		}
	}, [docContent]);

	function openDoc(path: string) {
		setQuery("");
		setHits(null);
		setNavOpen(false);
		onSelectDoc(path);
	}

	async function doCreate() {
		const title = newTitle.trim();
		setCreating(false);
		setNewTitle("");
		try {
			const note = await createNoteApi(title || undefined);
			refreshNotes();
			onSelectNote(note.id);
		} catch (e) {
			console.error("Create note failed:", e);
		}
	}

	async function doDelete(id: string, e: React.MouseEvent) {
		e.stopPropagation();
		if (!confirm("Delete this note? This affects everyone.")) return;
		try {
			await deleteNoteApi(id);
			refreshNotes();
			if (selNoteId === id) onSelectDoc(null);
		} catch (err) {
			console.error("Delete note failed:", err);
		}
	}

	function navigateMention(kind: MentionKind, target: string) {
		if (kind === "session") onOpenSession(target);
		else if (kind === "note") onSelectNote(target);
		else onSelectDoc(target);
	}

	return (
		<div className="notes">
			<div className={`notes-nav wiki-nav ${navOpen ? "wiki-nav-open" : ""}`}>
				{/* Notes section (writable, shared) */}
				<div className="notes-section">
					<div className="notes-section-head">
						<span>Notes</span>
						<button
							className="notes-add"
							title="New note"
							onClick={() => setCreating((c) => !c)}
						>
							＋
						</button>
					</div>
					{creating && (
						<input
							className="notes-new-input"
							autoFocus
							placeholder="Note title…"
							value={newTitle}
							onChange={(e) => setNewTitle(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") doCreate();
								else if (e.key === "Escape") {
									setCreating(false);
									setNewTitle("");
								}
							}}
							onBlur={() => doCreate()}
						/>
					)}
					<div className="notes-list">
						{notes.length === 0 && !creating ? (
							<div className="notes-empty">No notes yet</div>
						) : (
							notes.map((n) => (
								<div
									key={n.id}
									className={`notes-item ${selNoteId === n.id ? "notes-item-active" : ""}`}
									onClick={() => {
										setNavOpen(false);
										onSelectNote(n.id);
									}}
									title={n.title}
								>
									<span className="notes-item-title">{n.title}</span>
									<span
										className={`notes-item-pin ${pinnedNoteIds.has(n.id) ? "on" : ""}`}
										title={pinnedNoteIds.has(n.id) ? "Unpin tab" : "Pin as tab"}
										onClick={(e) => {
											e.stopPropagation();
											onTogglePinNote(n.id);
										}}
									>
										{pinnedNoteIds.has(n.id) ? "★" : "☆"}
									</span>
									<span
										className="notes-item-del"
										title="Delete note"
										onClick={(e) => doDelete(n.id, e)}
									>
										✕
									</span>
								</div>
							))
						)}
					</div>
				</div>

				{/* Docs section (read-only wiki) */}
				<div className="notes-section notes-section-docs">
					<div className="notes-section-head">
						<span>Docs</span>
					</div>
					<div className="wiki-search-wrap">
						<input
							className="wiki-search"
							placeholder="Search docs…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
					</div>
					{hits !== null ? (
						<div className="wiki-results">
							{hits.length === 0 ? (
								<div className="wiki-empty">No results</div>
							) : (
								hits.map((h, i) => (
									<button
										key={i}
										className="wiki-result"
										onClick={() => openDoc(h.path)}
									>
										<span className="wiki-result-title">{h.title}</span>
										<span className="wiki-result-snippet">{h.snippet}</span>
										<span className="wiki-result-path">{h.path}</span>
									</button>
								))
							)}
						</div>
					) : (
						<div className="wiki-tree">
							{paths.length > 0 && (
								<WikiTree paths={paths} docPath={selDocPath} onOpen={openDoc} />
							)}
						</div>
					)}
				</div>
			</div>

			<div
				className={`notes-content wiki-content ${selNoteId ? "notes-editing" : ""}`}
			>
				<button
					className="wiki-nav-toggle"
					onClick={() => setNavOpen(!navOpen)}
				>
					☰ Browse
				</button>

				{selNoteId ? (
					<NotePane
						key={selNoteId}
						noteId={selNoteId}
						user={user}
						connected={connected}
						send={send}
						addHandler={addHandler}
						sessions={sessions}
						notes={notes.map((n) => ({ id: n.id, title: n.title }))}
						onOpenMention={navigateMention}
					/>
				) : selDocPath ? (
					loadingDoc ? (
						<div className="loading">Loading…</div>
					) : (
						<>
							<div className="wiki-doc-path">{selDocPath}</div>
							<div
								className="markdown wiki-doc"
								dangerouslySetInnerHTML={{ __html: docHtml }}
							/>
						</>
					)
				) : (
					<div className="wiki-welcome">
						<h2>Notes</h2>
						<p>
							Shared, real-time collaborative notes — todos and longer ideas,
							edited live together. Create one with <b>＋</b>, @-tag
							sessions/notes/docs, pin a note as a tab, or prompt Haiku to
							update it.
						</p>
						<p className="wiki-welcome-hint">
							The <b>Docs</b> section below is the read-only knowledge base from{" "}
							<code>tella-fusion/docs</code>.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}

/** Right pane for an open note: presence + editor (top) + prompt bar (bottom). */
function NotePane({
	noteId,
	user,
	connected,
	send,
	addHandler,
	sessions,
	notes,
	onOpenMention,
}: {
	noteId: string;
	user: string;
	connected: boolean;
	send: Props["send"];
	addHandler: Props["addHandler"];
	sessions: Props["sessions"];
	notes: { id: string; title: string }[];
	onOpenMention: (kind: MentionKind, target: string) => void;
}) {
	const [viewers, setViewers] = useState<string[]>([]);
	const [promptOpen, setPromptOpen] = useState(true);
	const [prompt, setPrompt] = useState("");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Presence for this note.
	useEffect(() => {
		setViewers([]);
		return addHandler((msg) => {
			if (msg.type === "note_presence" && msg.noteId === noteId)
				setViewers(msg.viewers);
		});
	}, [noteId, addHandler]);

	async function runPrompt() {
		const text = prompt.trim();
		if (!text || running) return;
		setRunning(true);
		setError(null);
		try {
			await promptNoteApi(noteId, text);
			setPrompt(""); // the rewrite arrives live over the WS
		} catch (e: any) {
			setError(e?.message || "Update failed");
		} finally {
			setRunning(false);
		}
	}

	const others = viewers.filter((v) => v !== user);
	const [copied, setCopied] = useState(false);

	function shareNote() {
		const link = `${location.origin}/backstage/notes/${encodeURIComponent(noteId)}`;
		// navigator.clipboard only exists in a secure context — backstage is served
		// over plain http on the tailnet, so fall back to a hidden-textarea copy.
		const done = () => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		};
		if (navigator.clipboard?.writeText) {
			navigator.clipboard
				.writeText(link)
				.then(done, () => fallbackCopy(link, done));
		} else {
			fallbackCopy(link, done);
		}
	}

	return (
		<div className="note-pane">
			<div className="note-pane-bar">
				<span className="note-pane-id">{noteId}</span>
				{others.length > 0 && (
					<span
						className="note-presence"
						title={`Also here: ${others.join(", ")}`}
					>
						{others.slice(0, 4).map((v, i) => (
							<span key={i} className="note-presence-dot">
								{v.charAt(0).toUpperCase()}
							</span>
						))}
						<span className="note-presence-label">editing</span>
					</span>
				)}
				<button
					className="note-share"
					onClick={shareNote}
					title="Copy a link to this note"
				>
					{copied ? "✓ Link copied" : "⤴ Share"}
				</button>
			</div>

			<div className="note-editor-wrap">
				<Suspense fallback={<div className="loading">Loading editor…</div>}>
					<NoteEditor
						noteId={noteId}
						user={user}
						connected={connected}
						send={send}
						addHandler={addHandler}
						sessions={sessions}
						notes={notes}
						onOpenMention={onOpenMention}
					/>
				</Suspense>
			</div>

			<div
				className={`note-prompt ${promptOpen ? "" : "note-prompt-collapsed"} ${running ? "note-prompt-running" : ""}`}
			>
				<button
					className="note-prompt-toggle"
					onClick={() => setPromptOpen((o) => !o)}
					title={promptOpen ? "Collapse" : "Expand"}
				>
					<span className={`note-prompt-caret ${promptOpen ? "open" : ""}`}>
						›
					</span>
					prompt
					{running && <span className="note-spinner" />}
				</button>
				{promptOpen &&
					(running ? (
						<div className="note-prompt-loading">
							<span className="note-spinner note-spinner-lg" />
							<span>Haiku is updating the note…</span>
						</div>
					) : (
						<textarea
							className="note-prompt-input"
							placeholder="Ask Haiku to update this note… (↵ to run)"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									runPrompt();
								}
							}}
						/>
					))}
				{error && <div className="note-prompt-error">{error}</div>}
			</div>
		</div>
	);
}
