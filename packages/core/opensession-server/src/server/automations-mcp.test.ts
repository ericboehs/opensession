import { describe, expect, test } from "bun:test";
import { automationBaselineMcpServers } from "./automations";

describe("automation MCP fallback", () => {
  test("rebuilds the complete always-mounted automation-safe set", () => {
    const servers = automationBaselineMcpServers(
      { id: "auto-health", name: "Health Monitor" },
      "os-health-run",
    );

    expect(Object.keys(servers).sort()).toEqual([
      "opensession-audit",
      "opensession-health",
      "opensession-report",
      "opensession-turn",
    ]);
    for (const server of Object.values(servers)) {
      expect(server).toMatchObject({ type: "sdk" });
      expect((server as { instance?: unknown }).instance).toBeTruthy();
    }
  });
});
