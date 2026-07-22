import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNotesMcpServer, type NotesToolDeps } from "./notes-tools";

function makeDeps() {
  const notes = [
    { id: "roadmap", title: "Roadmap", updatedAt: 42 },
    { id: "todo", title: "Todo", updatedAt: 21 },
  ];
  const content = new Map([
    ["roadmap", "# Roadmap\n\nFirst draft."],
    ["todo", "# Todo\n\n- [ ] Ship it"],
  ]);
  const updates: Array<{ id: string; content: string }> = [];
  const broadcasts: Array<{ id: string; update: Uint8Array }> = [];
  const deleted: string[] = [];
  const deps: NotesToolDeps = {
    list: () => notes.filter((note) => !deleted.includes(note.id)),
    read: (id) => content.get(id) || "",
    update: (id, next) => {
      updates.push({ id, content: next });
      content.set(id, next);
      return new Uint8Array([1, 2, 3]);
    },
    delete: (id) => {
      if (!content.has(id)) return false;
      deleted.push(id);
      content.delete(id);
      return true;
    },
    broadcastUpdate: (id, update) => broadcasts.push({ id, update }),
  };
  return { deps, updates, broadcasts, deleted };
}

async function withClient<T>(deps: NotesToolDeps, run: (client: Client) => Promise<T>): Promise<T> {
  const server = createNotesMcpServer(deps);
  const client = new Client({ name: "notes-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.instance.close();
  }
}

function resultText(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  return first && first.type === "text" ? first.text || "" : "";
}

describe("opensession-notes MCP", () => {
  it("lists and reads shared notes", async () => {
    const { deps } = makeDeps();
    await withClient(deps, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_notes",
        "read_note",
        "update_note",
        "delete_note",
      ]);

      const listed = await client.callTool({ name: "list_notes", arguments: {} });
      expect(JSON.parse(resultText(listed)).notes).toHaveLength(2);

      const read = await client.callTool({
        name: "read_note",
        arguments: { id: "roadmap" },
      });
      expect(JSON.parse(resultText(read))).toEqual({
        id: "roadmap",
        title: "Roadmap",
        updatedAt: 42,
        content: "# Roadmap\n\nFirst draft.",
      });
    });
  });

  it("updates through the CRDT dependency and broadcasts the delta", async () => {
    const { deps, updates, broadcasts } = makeDeps();
    await withClient(deps, async (client) => {
      const result = await client.callTool({
        name: "update_note",
        arguments: { id: "roadmap", content: "# Roadmap\n\nRevised." },
      });
      expect(resultText(result)).toBe('Updated note "roadmap".');
    });

    expect(updates).toEqual([{ id: "roadmap", content: "# Roadmap\n\nRevised." }]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].id).toBe("roadmap");
    expect([...broadcasts[0].update]).toEqual([1, 2, 3]);
  });

  it("deletes existing notes and refuses phantom reads or updates", async () => {
    const { deps, updates, deleted } = makeDeps();
    await withClient(deps, async (client) => {
      const missingRead = await client.callTool({
        name: "read_note",
        arguments: { id: "missing" },
      });
      expect(resultText(missingRead)).toBe('Note "missing" was not found.');

      const missingUpdate = await client.callTool({
        name: "update_note",
        arguments: { id: "missing", content: "# Surprise" },
      });
      expect(resultText(missingUpdate)).toBe('Note "missing" was not found.');

      const removed = await client.callTool({
        name: "delete_note",
        arguments: { id: "todo" },
      });
      expect(resultText(removed)).toBe('Deleted note "todo".');
    });

    expect(updates).toEqual([]);
    expect(deleted).toEqual(["todo"]);
  });
});
