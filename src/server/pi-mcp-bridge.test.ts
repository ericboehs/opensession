/**
 * pi-mcp-bridge over real in-process McpServers on InMemoryTransport pairs —
 * no network, no stdio children. Covers the contract pi-runner relies on:
 * `<server>_<tool>` naming with denied ids dropped before registration
 * (exact + the broad `*_<tool>`/bare forms), JSON-Schema passthrough into
 * pi `parameters`, text/image/other content mapping, MCP isError → thrown
 * error (pi convention), per-call timeout that fails the call not the turn,
 * audit callbacks, and close() teardown.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import {
  classifyInProcessMcp,
  createPiMcpBridge,
  type PiMcpBridge,
} from "./pi-mcp-bridge";

function makeServer(name = "alpha") {
  return createSdkMcpServer({
    name,
    tools: [
      tool("echo", "Echo the text back", { text: z.string() }, async (args) => ({
        content: [{ type: "text", text: `echo:${args.text}` }],
      })),
      tool("picture", "Return text plus an image", {}, async () => ({
        content: [
          { type: "text", text: "here you go" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      })),
      tool("resourceish", "Return a resource block", {}, async () => ({
        content: [
          {
            type: "resource",
            resource: { uri: "mem://thing", mimeType: "text/plain", text: "inner" },
          },
        ] as CallToolResult["content"],
      })),
      tool("boom", "Always fails", {}, async () => ({
        isError: true,
        content: [{ type: "text", text: "boom: bad input" }],
      })),
      tool(
        "hang",
        "Never resolves",
        {},
        () => new Promise<CallToolResult>(() => {}),
      ),
    ],
  });
}

const openBridges: PiMcpBridge[] = [];
afterEach(async () => {
  for (const b of openBridges.splice(0)) await b.close();
});

async function makeBridge(
  overrides: Partial<Parameters<typeof createPiMcpBridge>[0]> = {},
) {
  const server = makeServer();
  const bridge = await createPiMcpBridge({
    mcpServers: [],
    deniedToolIds: new Set(),
    inProcessMcp: { alpha: server },
    ...overrides,
  });
  openBridges.push(bridge);
  return { server, bridge };
}

function toolByName(bridge: PiMcpBridge, name: string) {
  const def = bridge.tools.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def;
}

function discoveryToolByName(bridge: PiMcpBridge, name: string) {
  const def = bridge.discoveryTools.find((t) => t.name === name);
  if (!def) throw new Error(`discovery tool ${name} not registered`);
  return def;
}

const exec = (def: { execute: Function }, params: unknown = {}) =>
  def.execute("call-1", params, undefined, undefined, {} as any);

describe("inProcessMcp shapes", () => {
  /** What runner-host/host.ts's proxyMcpConfigs() writes for one server. */
  const hostProxy = (token: string, server = "opensession-workflows") => ({
    command: "/home/x/.bun/bin/bun",
    args: ["run", "/repo/src/runner-host/mcp-proxy.ts"],
    env: {
      OPENSESSION_RPC_SOCKET: "/home/x/.opensession-sessions/rpc.sock",
      OPENSESSION_RPC_TOKEN: token,
      OPENSESSION_MCP_SERVER: server,
    },
  });

  const proxyKey = (cfg: Record<string, unknown>) => {
    const [mount] = classifyInProcessMcp({ w: cfg });
    if (mount?.kind !== "proxy") throw new Error("expected a proxy mount");
    return mount.cacheKey;
  };

  test("mounts a detached run host's stdio proxy configs, not only SDK instances", () => {
    // The regression this guards: a hosted run passes proxy configs, and
    // dropping them left it with every external server and zero opensession-*
    // ones — which reads as "these tools were never configured".
    const mounts = classifyInProcessMcp({
      alpha: makeServer(),
      "opensession-workflows": hostProxy("tok-1"),
    });
    expect(mounts.map((m) => [m.name, m.kind])).toEqual([
      ["alpha", "sdk"],
      ["opensession-workflows", "proxy"],
    ]);
  });

  test("a proxy's cache key ignores the per-run token but not its real config", () => {
    expect(proxyKey(hostProxy("tok-1"))).toBe(proxyKey(hostProxy("tok-2")));
    expect(proxyKey(hostProxy("tok-1"))).not.toBe(
      proxyKey(hostProxy("tok-1", "opensession-sessions")),
    );
    expect(proxyKey(hostProxy("tok-1"))).not.toBe(
      proxyKey({ ...hostProxy("tok-1"), args: ["run", "/elsewhere.ts"] }),
    );
  });

  test("skips names an external server already claimed, and unrecognized shapes", () => {
    const mounts = classifyInProcessMcp(
      {
        alpha: makeServer(),
        junk: { type: "sdk" },
        "opensession-web": hostProxy("tok-1", "opensession-web"),
      },
      new Set(["alpha"]),
    );
    expect(mounts.map((m) => m.name)).toEqual(["opensession-web"]);
  });
});

describe("registration", () => {
  test("names tools <server>_<tool> and passes the JSON Schema through", async () => {
    const { bridge } = await makeBridge();
    expect(bridge.tools.map((t) => t.name).sort()).toEqual([
      "alpha_boom",
      "alpha_echo",
      "alpha_hang",
      "alpha_picture",
      "alpha_resourceish",
    ]);
    const echo = toolByName(bridge, "alpha_echo");
    // MCP inputSchema is plain JSON Schema (no TypeBox constructors involved)
    // and must reach pi's `parameters` untouched.
    const schema = echo.parameters as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.text.type).toBe("string");
    expect(echo.description).toBe("Echo the text back");
    expect(echo.label).toContain("alpha");
  });

  test("connects in-process servers during creation (listing needs a live connection)", async () => {
    const { server, bridge } = await makeBridge();
    expect(server.instance.isConnected()).toBe(true);
    expect(bridge.tools.length).toBeGreaterThan(0);
  });

  test("exposes a compact search-and-call surface instead of every MCP schema", async () => {
    const { bridge } = await makeBridge();
    expect(bridge.discoveryTools.map((t) => t.name)).toEqual(["mcp_search", "mcp_call"]);

    const search = await exec(discoveryToolByName(bridge, "mcp_search"), {
      query: "echo text",
    });
    expect(search.content[0].text).toContain("alpha_echo");
    expect(search.content[0].text).toContain("arguments:");

    const call = await exec(discoveryToolByName(bridge, "mcp_call"), {
      name: "alpha_echo",
      arguments: { text: "through dispatcher" },
    });
    expect(call.content).toEqual([{ type: "text", text: "echo:through dispatcher" }]);
  });

  test("non-sdk inProcessMcp values are skipped and an empty bridge is fine", async () => {
    const bridge = await createPiMcpBridge({
      mcpServers: [],
      deniedToolIds: new Set(),
      inProcessMcp: { bogus: { some: "thing" } },
    });
    openBridges.push(bridge);
    expect(bridge.tools).toEqual([]);
    expect(bridge.discoveryTools).toEqual([]);
    await bridge.close();
  });
});

describe("denied tools", () => {
  test("exact, wildcard and bare denied ids are dropped before registration", async () => {
    const { bridge } = await makeBridge({
      deniedToolIds: new Set(["alpha_echo", "*_picture", "boom"]),
    });
    expect(bridge.tools.map((t) => t.name).sort()).toEqual([
      "alpha_hang",
      "alpha_resourceish",
    ]);
  });
});

describe("content mapping", () => {
  test("text and image blocks map 1:1", async () => {
    const { bridge } = await makeBridge();
    const res = await exec(toolByName(bridge, "alpha_picture"));
    expect(res.content).toEqual([
      { type: "text", text: "here you go" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
  });

  test("params reach the tool and text round-trips", async () => {
    const { bridge } = await makeBridge();
    const res = await exec(toolByName(bridge, "alpha_echo"), { text: "hi" });
    expect(res.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  test("resource blocks JSON-stringify to text", async () => {
    const { bridge } = await makeBridge();
    const res = await exec(toolByName(bridge, "alpha_resourceish"));
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("mem://thing");
  });
});

describe("errors, audit and timeout", () => {
  test("MCP isError results are thrown, not returned", async () => {
    const audits: Array<{ server: string; tool: string; ok: boolean; ms: number }> = [];
    const { bridge } = await makeBridge({ onAudit: (e) => audits.push(e) });
    await expect(exec(toolByName(bridge, "alpha_boom"))).rejects.toThrow(
      "boom: bad input",
    );
    expect(audits).toEqual([
      { server: "alpha", tool: "boom", ok: false, ms: expect.any(Number) },
    ]);
  });

  test("successful calls audit ok:true", async () => {
    const audits: Array<{ ok: boolean; tool: string }> = [];
    const { bridge } = await makeBridge({
      onAudit: (e) => audits.push({ ok: e.ok, tool: e.tool }),
    });
    await exec(toolByName(bridge, "alpha_echo"), { text: "x" });
    expect(audits).toEqual([{ ok: true, tool: "echo" }]);
  });

  test("a wedged call times out and fails the call, not the bridge", async () => {
    const { bridge } = await makeBridge({ callTimeoutMs: 100 });
    await expect(exec(toolByName(bridge, "alpha_hang"))).rejects.toThrow(
      /timed out|timeout/i,
    );
    // The bridge stays usable for other tools after a timeout.
    const res = await exec(toolByName(bridge, "alpha_echo"), { text: "still-alive" });
    expect(res.content[0].text).toBe("echo:still-alive");
  });
});

describe("close", () => {
  test("tears down transports and refuses further calls", async () => {
    const { server, bridge } = await makeBridge();
    await bridge.close();
    expect(server.instance.isConnected()).toBe(false);
    await expect(exec(toolByName(bridge, "alpha_echo"), { text: "x" })).rejects.toThrow(
      /closed/i,
    );
    // Idempotent.
    await bridge.close();
  });
});
