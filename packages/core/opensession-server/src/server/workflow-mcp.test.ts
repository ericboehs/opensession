import { describe, expect, test } from "bun:test";
import { createWorkflowMcpHost, workflowMcpServers } from "./workflow-mcp";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";

// Policy only — no transport is opened: every assertion here is refused
// BEFORE a client connects (that's the point of checking first).

describe("workflowMcpServers", () => {
	test("drops servers owning a confirm-gated tool, keeps the rest", () => {
		const out = workflowMcpServers({
			grafana: { command: "mcp-grafana" },
			stripe: { type: "http", url: "https://mcp.stripe.com" },
			linear: { type: "http", url: "https://mcp.linear.app/mcp" },
		});
		expect(Object.keys(out).sort()).toEqual(["grafana", "linear"]);
	});

	test("every confirm-gated server in the catalog is covered", () => {
		// The drop is derived from STRIPE_CONFIRM_TOOLS, so a tool added there
		// closes the hole here too — assert the derivation, not a literal list.
		const servers = new Set(
			Object.keys(STRIPE_CONFIRM_TOOLS).map((id) => id.split("__")[1]),
		);
		const configured: Record<string, unknown> = { safe: {} };
		for (const s of servers) configured[s] = {};
		expect(Object.keys(workflowMcpServers(configured))).toEqual(["safe"]);
	});

	test("an empty surface stays empty", () => {
		expect(workflowMcpServers({})).toEqual({});
	});
});

describe("workflow MCP host policy", () => {
	const host = (deniedTools?: Record<string, string>) =>
		createWorkflowMcpHost({
			deniedTools,
			configuredForTest: {
				grafana: { command: "mcp-grafana" },
				plain: { command: "plain-mcp" },
				stripe: { type: "http", url: "https://mcp.stripe.com" },
			},
		});

	test("servers() lists the allowed surface without the gated server", () => {
		expect(host().servers()).toEqual(["grafana", "plain"]);
	});

	test("calling a confirm-gated server is refused with the propose-it hint", async () => {
		await expect(host().call("stripe", "create_refund", {})).rejects.toThrow(
			/confirm-gated/i,
		);
	});

	test("an unknown server is refused and lists what IS available", async () => {
		const promise = host().call("nope", "whatever", {});
		await expect(promise).rejects.toThrow(/no MCP server "nope"/);
		await expect(promise).rejects.toThrow(/grafana, plain/);
	});

	test("a denied tool is refused with the denial's own reason", async () => {
		const denied = host({
			mcp__plain__reply_to_thread: "Use an internal note instead.",
		});
		await expect(
			denied.call("plain", "reply_to_thread", { text: "hi" }),
		).rejects.toThrow(/Use an internal note instead/);
		// Sibling tools on the same server stay reachable (the denial is
		// per-tool, not per-server) — this one fails on transport, not policy.
		await expect(denied.call("plain", "get_thread", {})).rejects.not.toThrow(
			/not available/,
		);
	});

	test("a closed host refuses further calls", async () => {
		const h = host();
		await h.close();
		await expect(h.call("grafana", "anything", {})).rejects.toThrow(/closed/i);
	});
});
