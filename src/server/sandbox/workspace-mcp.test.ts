import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalProvider } from "./local";
import { createRemoteWorkspaceMcpServer } from "./workspace-mcp";

const scratch: string[] = [];

function resultText(result: unknown): string {
  const first = (result as { content?: Array<{ type?: string; text?: string }> }).content?.[0];
  return first?.type === "text" ? first.text || "" : "";
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("opensession-workspace MCP", () => {
  test("all workspace operations execute through the Sandbox handle", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "opensession-workspace-"));
    scratch.push(cwd);
    const sandbox = await new LocalProvider().ensure({
      sessionId: "test",
      cwd,
      mode: "code",
    });
    const server = createRemoteWorkspaceMcpServer(sandbox);
    const client = new Client({ name: "workspace-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((entry) => entry.name)).toEqual([
        "execute",
        "read_file",
        "write_file",
        "edit_file",
        "grep",
        "glob",
      ]);

      const wrote = await client.callTool({
        name: "write_file",
        arguments: { path: "src/example.ts", content: "export const before = 1;\n" },
      });
      expect(resultText(wrote)).toContain("Wrote");

      const read = await client.callTool({
        name: "read_file",
        arguments: { path: "src/example.ts" },
      });
      expect(resultText(read)).toContain("export const before = 1");

      const edited = await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/example.ts",
          old_text: "before = 1",
          new_text: "after = 2",
        },
      });
      expect(resultText(edited)).toContain("Updated");

      const grep = await client.callTool({
        name: "grep",
        arguments: { pattern: "after", path: "src" },
      });
      expect(resultText(grep)).toContain("after = 2");

      const glob = await client.callTool({
        name: "glob",
        arguments: { pattern: "**/*.ts" },
      });
      expect(resultText(glob)).toContain("src/example.ts");

      const executed = await client.callTool({
        name: "execute",
        arguments: { command: "pwd" },
      });
      expect(resultText(executed)).toContain(cwd);
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
});
