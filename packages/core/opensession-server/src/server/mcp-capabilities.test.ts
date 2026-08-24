import { describe, expect, test } from "bun:test";
import { INTERNAL_MCP_CAPABILITIES } from "./mcp-capabilities";
import { MCP_SERVER_CATALOG } from "./mcp-catalog";

describe("internal MCP capability metadata", () => {
  test("covers the complete server catalog", () => {
    expect(Object.keys(INTERNAL_MCP_CAPABILITIES).sort()).toEqual(
      MCP_SERVER_CATALOG.map((entry) => entry.name).sort(),
    );
  });
});
