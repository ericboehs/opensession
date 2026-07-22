/**
 * opensession-notes — shared notes access for trusted interactive sessions.
 *
 * Notes are workspace-wide and can contain sensitive material, so this server
 * follows the other interactive-only opensession-* tools and is never exposed
 * to automation runs. Updates go through the Yjs-backed store and are broadcast
 * to open editors so MCP and human edits stay in sync.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import {
  deleteNote,
  getNoteText,
  listNotes,
  setNoteText,
  type NoteMeta,
} from "../../server/notes";
import { b64encode, broadcastToNote } from "../../server/ws-hub";

export interface NotesToolDeps {
  list: () => NoteMeta[];
  read: (id: string) => string;
  update: (id: string, content: string) => Uint8Array;
  delete: (id: string) => boolean;
  broadcastUpdate: (id: string, update: Uint8Array) => void;
}

const defaultDeps: NotesToolDeps = {
  list: listNotes,
  read: getNoteText,
  update: setNoteText,
  delete: deleteNote,
  broadcastUpdate: (id, update) => {
    if (!update.length) return;
    broadcastToNote(id, {
      type: "note_update",
      noteId: id,
      update: b64encode(update),
    });
  },
};

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function findNote(deps: NotesToolDeps, id: string): NoteMeta | undefined {
  return deps.list().find((note) => note.id === id);
}

export function createNotesMcpServer(deps: NotesToolDeps = defaultDeps) {
  const tools = [
    tool(
      "list_notes",
      "List all shared OpenSession notes, newest first. Returns each note's id, title, and last-updated timestamp; use the id with read_note, update_note, or delete_note.",
      {},
      async () => text(JSON.stringify({ notes: deps.list() }, null, 2)),
    ),
    tool(
      "read_note",
      "Read a shared OpenSession note by id, including its metadata and complete Markdown content. Use list_notes when the id is unknown.",
      {
        id: z.string().describe("The note id returned by list_notes."),
      },
      async (args: { id: string }) => {
        const id = args.id.trim();
        const note = findNote(deps, id);
        if (!note) return text(`Note \"${id}\" was not found.`);
        return text(
          JSON.stringify(
            {
              ...note,
              content: deps.read(id),
            },
            null,
            2,
          ),
        );
      },
    ),
    tool(
      "update_note",
      "Replace a shared OpenSession note's complete Markdown content. This is available in read-only Ask sessions because it changes shared Desk state, not repository files. The change is applied as a minimal Yjs diff and appears immediately for people editing the note. Read the note first to avoid overwriting newer content.",
      {
        id: z.string().describe("The note id returned by list_notes."),
        content: z.string().describe("The complete replacement Markdown content."),
      },
      async (args: { id: string; content: string }) => {
        const id = args.id.trim();
        if (!findNote(deps, id)) return text(`Note \"${id}\" was not found.`);
        const update = deps.update(id, args.content);
        deps.broadcastUpdate(id, update);
        return text(`Updated note \"${id}\".`);
      },
    ),
    tool(
      "delete_note",
      "Permanently delete a shared OpenSession note by id. This removes the note for everyone and cannot be undone.",
      {
        id: z.string().describe("The note id returned by list_notes."),
      },
      async (args: { id: string }) => {
        const id = args.id.trim();
        if (!findNote(deps, id)) return text(`Note \"${id}\" was not found.`);
        return deps.delete(id)
          ? text(`Deleted note \"${id}\".`)
          : text(`Note \"${id}\" was not found.`);
      },
    ),
  ];

  return createSdkMcpServer({ name: "opensession-notes", version: "1.0.0", tools });
}
