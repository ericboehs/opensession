/**
 * Shared, real-time collaborative notes store at `~/.opensession-notes/`.
 *
 * Unlike the read-only wiki (src/server/wiki.ts), notes are writable and shared
 * between ALL users — there is no per-user scoping. Each note is a Yjs CRDT
 * document so many people can edit it live without last-write-wins clobbering
 * (the editing/sync wiring mirrors session collaboration: see noteWatchers in
 * backstage.ts).
 *
 * Each note persists as two files keyed by a slug id:
 *   <id>.ydoc — binary `Y.encodeStateAsUpdate` (the source of truth for collab)
 *   <id>.md   — the Y.Text content as plain markdown (human-readable snapshot;
 *               git-friendly and what the Haiku rewrite in note-edit.ts reads)
 *
 * Live `Y.Doc`s are cached in-memory and parked on globalThis so a `bun --hot`
 * reload doesn't drop in-flight collaborative state (same trick as
 * __sessionWatchers).
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	statSync,
	unlinkSync,
} from "fs";
import * as Y from "yjs";
import { stateDir } from "./rename-compat";

const NOTES_DIR = stateDir("notes");

/** The single Y.Text field every note doc carries. */
const TEXT_FIELD = "content";

export interface NoteMeta {
	id: string;
	title: string;
	updatedAt: number; // ms epoch
}

// ── In-memory live docs (survive hot reload) ──────────────────────────────
const g = globalThis as unknown as {
	__noteDocs?: Map<string, Y.Doc>;
	__notePersistTimers?: Map<string, ReturnType<typeof setTimeout>>;
};
const noteDocs: Map<string, Y.Doc> = (g.__noteDocs ??= new Map());
const persistTimers: Map<
	string,
	ReturnType<typeof setTimeout>
> = (g.__notePersistTimers ??= new Map());

const PERSIST_DEBOUNCE_MS = 1500;

// ── Path / id safety ──────────────────────────────────────────────────────
/** Note ids are filename-safe slugs; this also blocks path traversal. */
export function isValidNoteId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function ydocPath(id: string): string {
	return `${NOTES_DIR}/${id}.ydoc`;
}
function mdPath(id: string): string {
	return `${NOTES_DIR}/${id}.md`;
}

function ensureDir(): void {
	if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true });
}

/** Turn a free-form title into a unique, filename-safe note id. */
function slugify(title: string): string {
	const base =
		title
			.trim()
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "note";
	let id = base;
	let n = 2;
	while (existsSync(mdPath(id)) || existsSync(ydocPath(id))) {
		id = `${base}-${n++}`;
	}
	return id;
}

/** First markdown heading, else the id, as the note's display title. */
function titleFromMarkdown(md: string, fallback: string): string {
	for (const line of md.split("\n", 30)) {
		const m = line.match(/^#{1,6}\s+(.+)/);
		if (m) return m[1].trim();
	}
	const firstNonEmpty = md.split("\n").find((l) => l.trim().length > 0);
	return (firstNonEmpty || fallback).slice(0, 80).trim() || fallback;
}

// ── Doc lifecycle ─────────────────────────────────────────────────────────
/**
 * Return the live Y.Doc for a note, loading it from disk on first access:
 * prefer the binary `.ydoc`; otherwise seed the Y.Text from an existing `.md`;
 * otherwise empty.
 */
export function getNoteDoc(id: string): Y.Doc {
	let doc = noteDocs.get(id);
	if (doc) return doc;

	doc = new Y.Doc();
	try {
		if (existsSync(ydocPath(id))) {
			Y.applyUpdate(doc, new Uint8Array(readFileSync(ydocPath(id))));
		} else if (existsSync(mdPath(id))) {
			const md = readFileSync(mdPath(id), "utf8");
			if (md.length) doc.getText(TEXT_FIELD).insert(0, md);
		}
	} catch (e) {
		console.error(`[notes] failed to load ${id}:`, e);
	}
	noteDocs.set(id, doc);
	return doc;
}

/** Persist a note's doc to disk now (both the binary state and the .md snapshot). */
function persistNow(id: string): void {
	const doc = noteDocs.get(id);
	if (!doc) return;
	try {
		ensureDir();
		writeFileSync(ydocPath(id), Buffer.from(Y.encodeStateAsUpdate(doc)));
		writeFileSync(mdPath(id), doc.getText(TEXT_FIELD).toString());
	} catch (e) {
		console.error(`[notes] failed to persist ${id}:`, e);
	}
}

/** Debounced persist — coalesces a burst of collaborative edits into one write. */
function schedulePersist(id: string): void {
	const existing = persistTimers.get(id);
	if (existing) clearTimeout(existing);
	persistTimers.set(
		id,
		setTimeout(() => {
			persistTimers.delete(id);
			persistNow(id);
		}, PERSIST_DEBOUNCE_MS),
	);
}

// ── Public API ────────────────────────────────────────────────────────────
/** List notes (from the .md snapshots), most recently updated first. */
export function listNotes(): NoteMeta[] {
	ensureDir();
	let files: string[];
	try {
		files = readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const notes: NoteMeta[] = [];
	for (const file of files) {
		const id = file.slice(0, -3);
		if (!isValidNoteId(id)) continue;
		try {
			// Prefer live in-memory text (a loaded doc is fresher than the snapshot).
			const live = noteDocs.get(id);
			const md = live
				? live.getText(TEXT_FIELD).toString()
				: readFileSync(mdPath(id), "utf8");
			notes.push({
				id,
				title: titleFromMarkdown(md, id),
				updatedAt: statSync(mdPath(id)).mtimeMs,
			});
		} catch {}
	}
	return notes.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Create a new note with a starter heading; returns its meta. */
export function createNote(title?: string): NoteMeta {
	ensureDir();
	const clean = (title || "").trim() || "Untitled note";
	const id = slugify(clean);
	const doc = new Y.Doc();
	doc.getText(TEXT_FIELD).insert(0, `# ${clean}\n\n`);
	noteDocs.set(id, doc);
	persistNow(id);
	return { id, title: clean, updatedAt: Date.now() };
}

/** Delete a note and forget its live doc. */
export function deleteNote(id: string): boolean {
	if (!isValidNoteId(id)) return false;
	noteDocs.delete(id);
	const t = persistTimers.get(id);
	if (t) {
		clearTimeout(t);
		persistTimers.delete(id);
	}
	let existed = false;
	for (const p of [ydocPath(id), mdPath(id)]) {
		try {
			if (existsSync(p)) {
				unlinkSync(p);
				existed = true;
			}
		} catch {}
	}
	return existed;
}

/** Full state for a freshly-joining client to sync against. */
export function getNoteState(id: string): Uint8Array {
	return Y.encodeStateAsUpdate(getNoteDoc(id));
}

/** Apply a collaborative update (from a client) to the shared doc + persist. */
export function applyNoteUpdate(id: string, update: Uint8Array): void {
	Y.applyUpdate(getNoteDoc(id), update);
	schedulePersist(id);
}

/** Current plain-markdown text of a note (for the Haiku rewrite). */
export function getNoteText(id: string): string {
	return getNoteDoc(id).getText(TEXT_FIELD).toString();
}

/** A note's text without forcing its Y.Doc into memory: live doc when loaded,
 *  else the .md snapshot straight from disk (used by search/backlinks, which
 *  sweep every note). */
function peekNoteText(id: string): string {
	const live = noteDocs.get(id);
	if (live) return live.getText(TEXT_FIELD).toString();
	try {
		return readFileSync(mdPath(id), "utf8");
	} catch {
		return "";
	}
}

export interface NoteSearchHit {
	id: string;
	title: string;
	line: number;
	snippet: string;
}

/** Case-insensitive substring search across every note (one hit per note —
 *  the first matching line). Sits beside searchWiki for the combined box. */
export function searchNotes(q: string): NoteSearchHit[] {
	const needle = q.trim().toLowerCase();
	if (needle.length < 2) return [];
	const hits: NoteSearchHit[] = [];
	for (const meta of listNotes()) {
		const lines = peekNoteText(meta.id).split("\n");
		const idx = lines.findIndex((l) => l.toLowerCase().includes(needle));
		if (idx === -1) continue;
		hits.push({
			id: meta.id,
			title: meta.title,
			line: idx + 1,
			snippet: lines[idx].trim().slice(0, 160),
		});
		if (hits.length >= 20) break;
	}
	return hits;
}

/** Notes whose text links to `id` via a `[label](note:id)` mention chip. */
export function noteBacklinks(id: string): Array<{ id: string; title: string }> {
	if (!isValidNoteId(id)) return [];
	const marker = `(note:${id})`;
	const out: Array<{ id: string; title: string }> = [];
	for (const meta of listNotes()) {
		if (meta.id === id) continue;
		if (peekNoteText(meta.id).includes(marker))
			out.push({ id: meta.id, title: meta.title });
	}
	return out;
}

/**
 * Replace a note's text with `next`, applied as a minimal prefix/suffix diff so
 * concurrent human edits outside the changed region survive. Returns the Yjs
 * update produced, so the caller can broadcast it to other watchers.
 */
export function setNoteText(id: string, next: string): Uint8Array {
	const doc = getNoteDoc(id);
	const ytext = doc.getText(TEXT_FIELD);
	const prev = ytext.toString();

	// Common prefix.
	let start = 0;
	const minLen = Math.min(prev.length, next.length);
	while (start < minLen && prev[start] === next[start]) start++;
	// Common suffix (not overlapping the prefix).
	let prevEnd = prev.length;
	let nextEnd = next.length;
	while (
		prevEnd > start &&
		nextEnd > start &&
		prev[prevEnd - 1] === next[nextEnd - 1]
	) {
		prevEnd--;
		nextEnd--;
	}

	let captured: Uint8Array = new Uint8Array();
	const onUpdate = (update: Uint8Array) => {
		captured = update;
	};
	doc.on("update", onUpdate);
	doc.transact(() => {
		const delLen = prevEnd - start;
		if (delLen > 0) ytext.delete(start, delLen);
		const insStr = next.slice(start, nextEnd);
		if (insStr) ytext.insert(start, insStr);
	});
	doc.off("update", onUpdate);

	schedulePersist(id);
	return captured;
}

/** Seed a starter note the first time the Notes page is opened on a fresh box. */
export function seedIfEmpty(): void {
	ensureDir();
	let hasNotes = false;
	try {
		hasNotes = readdirSync(NOTES_DIR).some((f) => f.endsWith(".md"));
	} catch {}
	if (hasNotes) return;
	const doc = new Y.Doc();
	doc
		.getText(TEXT_FIELD)
		.insert(
			0,
			"# NOTES.md\n\nShared notes & todos. Edit live together, @-tag sessions, and ask the assistant to update a note from the bar below.\n\n## Todo\n\n- [ ] \n",
		);
	noteDocs.set("NOTES", doc);
	persistNow("NOTES");
}
