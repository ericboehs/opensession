/**
 * OpenCode plugin: tag in-process (michael-* / opensession-*) MCP tool calls
 * with the opencode session id, so the run-rpc layer can route each call to
 * the RIGHT backstage session on a SHARED opencode server (one `opencode
 * serve` hosting many sessions — see opencode-runner.ts "Server lifecycle").
 *
 * Why: the stdio proxies (src/runner-host/mcp-proxy.ts) carry ONE rpc token
 * per server process, so on a shared server the token alone no longer
 * identifies the calling session. This hook injects `__bks_oc_session` into
 * the tool arguments; the proxy strips it back out of the args and forwards
 * it as a sibling `ocSession` field; run-rpc resolves it via the registry
 * opencode-runner maintains for active runs (ocSessionId → {bksSessionId,
 * user}), validated against the same rpc token.
 *
 * The injection happens AFTER the model produced the arguments
 * (tool.execute.before mutates them), so a model-forged value is always
 * overwritten for the tagged tools. Verified live 2026-07-09 against
 * opencode 1.17.15.
 *
 * MUST stay a plain .js file — opencode's plugin loader failed to load a .ts
 * sibling in live testing.
 */
const TAGGED_PREFIXES = ["michael", "opensession-"];

export const SessionTagPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String((input && input.tool) || "");
      if (!TAGGED_PREFIXES.some((p) => tool.startsWith(p))) return;
      if (output && output.args && typeof output.args === "object") {
        output.args.__bks_oc_session = (input && input.sessionID) || "";
      } else if (output) {
        output.args = { __bks_oc_session: (input && input.sessionID) || "" };
      }
    },
  };
};
