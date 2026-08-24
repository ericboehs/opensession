import { afterEach, describe, expect, test } from "bun:test";
import { startMcpOauthFlow } from "./mcp-oauth";

describe("MCP OAuth client registration", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("explains Figma's catalog restriction instead of reporting invalid JSON", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.figma.com/mcp",
          authorization_servers: ["https://api.figma.com"],
          scopes_supported: ["mcp:connect"],
        });
      }
      if (url === "https://api.figma.com/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: "https://www.figma.com/oauth/mcp",
          token_endpoint: "https://api.figma.com/v1/oauth/token",
          registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        });
      }
      if (url === "https://api.figma.com/v1/oauth/mcp/register") {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      startMcpOauthFlow("Figma test", "https://mcp.figma.com/mcp"),
    ).rejects.toThrow(
      "Its remote MCP server accepts only clients listed in the Figma MCP Catalog",
    );
  });
});
