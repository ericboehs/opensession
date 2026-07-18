/**
 * OpenCode plugin: re-parse MCP tool arguments the model emitted as
 * JSON-encoded STRINGS where the server's schema wants an object/array.
 *
 * Why: property-less object schemas (`{"type":"object"}`, free-form maps —
 * Stripe's `parameters`, Grafana's `labels`) reliably make models across
 * every provider stringify the value ("{\"customer\": ...}"), and opencode
 * forwards arguments verbatim — the MCP server then rejects the call
 * (-32602/-32603) and the model retries the identical string. 117 such
 * failures across fable/opus/sonnet/sol the week of 2026-07-17; upstream
 * closed the coercion proposal as not-planned (anomalyco/opencode #7512,
 * #28472), so we repair it here.
 *
 * Scope: NEVER builtin tools (a Write of a .json file legitimately carries
 * JSON in a string arg) — only MCP-style tools, and only top-level string
 * values that parse to a plain object/array. tool.execute.before mutates
 * output.args in place; the same reference reaches execute (verified in
 * v1.17.15 session/tools.ts).
 *
 * MUST stay a plain .js file — opencode's plugin loader failed to load a .ts
 * sibling in live testing.
 */
const BUILTIN_TOOLS = new Set([
  "bash", "read", "write", "edit", "patch", "grep", "glob", "list", "ls",
  "task", "todowrite", "todoread", "webfetch", "websearch", "skill",
]);

// In-process opensession-*/michael-* tools have fully-typed schemas (models
// don't stringify those) and may legitimately carry JSON in string args
// (papercut text, session prompts) — never touch them.
const EXCLUDED_PREFIXES = ["michael", "opensession"];

export const ArgCoercePlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String((input && input.tool) || "");
      if (!tool || BUILTIN_TOOLS.has(tool.toLowerCase())) return;
      if (EXCLUDED_PREFIXES.some((p) => tool.toLowerCase().startsWith(p))) return;
      const args = output && output.args;
      if (!args || typeof args !== "object") return;
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
            !(trimmed.startsWith("[") && trimmed.endsWith("]"))) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") args[key] = parsed;
        } catch {
          // Not valid JSON — leave the string alone.
        }
      }
    },
  };
};
