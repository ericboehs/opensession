/**
 * Notes (collaborative Yjs docs) + the read-only wiki.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { editNote } from "../note-edit";
import { createNote, deleteNote, getNoteText, isValidNoteId, listNotes, seedIfEmpty, setNoteText } from "../notes";
import { getWikiFile, getWikiTree, searchWiki } from "../wiki";
import { b64encode, broadcastToNote } from "../ws-hub";

export async function handleNotesRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Notes (shared, collaborative; content syncs over WS) ──
	if (path === "/backstage/api/notes" && req.method === "GET") {
		seedIfEmpty();
		return Response.json({ notes: listNotes() });
	}

	if (path === "/backstage/api/notes" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const note = createNote(
			typeof body?.title === "string" ? body.title : undefined,
		);
		return Response.json({ note });
	}

	// Full-text search across notes (merged with docs hits client-side).
	// Must precede the generic /notes/:id matcher ("search" is not an id).
	if (path === "/backstage/api/notes/search" && req.method === "GET") {
		const { searchNotes } = await import("../../server/notes");
		return Response.json({
			hits: searchNotes(url.searchParams.get("q") || ""),
		});
	}

	const noteBacklinksMatch = path.match(
		/^\/backstage\/api\/notes\/([^/]+)\/backlinks$/,
	);
	if (noteBacklinksMatch && req.method === "GET") {
		const id = decodeURIComponent(noteBacklinksMatch[1]);
		if (!isValidNoteId(id))
			return Response.json({ error: "Invalid id" }, { status: 400 });
		const { noteBacklinks } = await import("../../server/notes");
		return Response.json({ notes: noteBacklinks(id) });
	}

	const noteMatch = path.match(/^\/backstage\/api\/notes\/([^/]+)$/);
	if (noteMatch && req.method === "GET") {
		const id = decodeURIComponent(noteMatch[1]);
		if (!isValidNoteId(id))
			return Response.json({ error: "Invalid id" }, { status: 400 });
		const notes = listNotes();
		const meta = notes.find((n) => n.id === id);
		if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
		return Response.json({ ...meta, text: getNoteText(id) });
	}

	if (noteMatch && req.method === "DELETE") {
		const id = decodeURIComponent(noteMatch[1]);
		if (!isValidNoteId(id))
			return Response.json({ error: "Invalid id" }, { status: 400 });
		return deleteNote(id)
			? Response.json({ ok: true })
			: Response.json({ error: "Not found" }, { status: 404 });
	}

	const notePromptMatch = path.match(
		/^\/backstage\/api\/notes\/([^/]+)\/prompt$/,
	);
	if (notePromptMatch && req.method === "POST") {
		const id = decodeURIComponent(notePromptMatch[1]);
		if (!isValidNoteId(id))
			return Response.json({ error: "Invalid id" }, { status: 400 });
		const body = await req.json().catch(() => null);
		const instruction = typeof body?.prompt === "string" ? body.prompt : "";
		if (!instruction.trim())
			return Response.json({ error: "prompt required" }, { status: 400 });
		const next = await editNote(getNoteText(id), instruction);
		if (next == null)
			return Response.json(
				{ error: "Could not update the note" },
				{ status: 422 },
			);
		// Apply as a minimal diff to the shared doc and broadcast to editors.
		const update = setNoteText(id, next);
		if (update.length)
			broadcastToNote(id, {
				type: "note_update",
				noteId: id,
				update: b64encode(update),
			});
		return Response.json({ ok: true });
	}

	// ── Wiki ──
	if (path === "/backstage/api/wiki/tree" && req.method === "GET") {
		return Response.json(getWikiTree());
	}

	if (path === "/backstage/api/wiki/file" && req.method === "GET") {
		const rel = url.searchParams.get("path") || "";
		const file = getWikiFile(rel);
		if (!file)
			return Response.json({ error: "Not found" }, { status: 404 });
		return Response.json(file);
	}

	if (path === "/backstage/api/wiki/search" && req.method === "GET") {
		const q = url.searchParams.get("q") || "";
		return Response.json(searchWiki(q));
	}

	return undefined;
}
