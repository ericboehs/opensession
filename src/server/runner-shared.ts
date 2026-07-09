/**
 * Engine-neutral runner infrastructure shared across the engine and agents:
 *
 * - filterMcpServers: per-run MCP resolution (allowlist + per-user
 *   `allowedUsers` gating, strips our metadata before the config reaches an
 *   engine).
 * - STRIPE_CONFIRM_TOOLS: the money-moving Stripe tool catalog (confirm-listed
 *   in interactive runs, denied/stripped in unattended ones).
 * - isClaudeUsageLimitError / isCodexUsageLimitError: provider usage-limit
 *   detection driving account rotation and model fallback.
 * - CLAUDE_CODE_BIN: the Claude Code CLI path (the Meridian bridge's motor).
 */
import { readMcpConfig, withDynamicCredentials } from "./connections";
import { userMatchesAny } from "./shared/user-mappings";
import { configuredPaths } from "./config";

/** Claude Code CLI binary the Meridian bridge / anthropic-bridge spawn.
 *  BACKSTAGE_CLAUDE_BIN env → config `paths.claudeBin` → this VPS's path. */
export const CLAUDE_CODE_BIN = configuredPaths().claudeBin;

/**
 * Resolve the MCP servers for a run: all configured, or just the allowlist,
 * minus any server whose per-user `allowedUsers` list excludes `user`. The
 * `allowedUsers` field is stripped from every entry before it reaches an
 * engine (it's our metadata, not MCP config).
 */
export function filterMcpServers(
  allowlist?: string[],
  user?: string
): Record<string, unknown> {
  const all = withDynamicCredentials(readMcpConfig().mcpServers);
  const out: Record<string, unknown> = {};
  const names = allowlist ?? Object.keys(all);
  for (const name of names) {
    const cfg = all[name] as any;
    if (!cfg) {
      if (allowlist) console.warn(`[runner] MCP allowlist names unknown server "${name}" — skipping`);
      continue;
    }
    const { allowedUsers, ...entry } = cfg;
    if (Array.isArray(allowedUsers) && allowedUsers.length && !userMatchesAny(user, allowedUsers)) {
      // User-restricted server this run's user isn't cleared for — hide it.
      continue;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * Money-moving Stripe tools: interactive OpenSession runs drop the whole
 * server fail-closed (no per-call approval bridge on the opencode engine);
 * unattended runs strip these from the tool list with propose-it-in-your-
 * output guidance. The raw-API tools are included because they can hit any
 * endpoint the restricted key allows, including refunds and cancels.
 *
 * Keep this list in sync with mcp.stripe.com's live catalog: verified
 * 2026-07-09 the server now exposes `stripe_api_write` (mutating raw API
 * call — the successor of `stripe_api_execute`) plus read-only
 * `stripe_api_read`/`stripe_api_search`/`stripe_api_details`, and no longer
 * ships cancel/update_subscription as named tools. The superseded names stay
 * listed (a deny/confirm entry for a tool that doesn't exist is harmless; a
 * missing entry for one that does is a hole).
 */
export const STRIPE_CONFIRM_TOOLS: Record<string, string> = {
  mcp__stripe__create_refund: "Create a refund",
  mcp__stripe__cancel_subscription: "Cancel a subscription",
  mcp__stripe__update_subscription: "Update a subscription",
  mcp__stripe__stripe_api_execute: "Execute a raw Stripe API call",
  mcp__stripe__stripe_api_write: "Execute a mutating Stripe API call",
};

// `strict` matching applies to successful results too — the CLI reports usage
// limits as a plain result text ("Claude AI usage limit reached|<ts>",
// "5-hour limit reached ∙ resets …"), with subtype "success". The looser
// heuristic only applies to error results, where false positives can't
// clobber a legitimate answer.
export function isClaudeUsageLimitError(message: string, isErrorResult: boolean): boolean {
  const s = message.toLowerCase();
  // Observed CLI phrasings: "You've hit your session limit · resets 12:50pm (UTC)",
  // "Claude AI usage limit reached|<ts>", "5-hour limit reached ∙ resets 3am"
  if (/you've hit your .{0,20}limit/.test(s)) return true;
  // Credit-metered premium models (e.g. Fable 5) exhaust a separate per-account
  // credit pool, not the 5-hour session limit, and say so with none of the
  // "limit/reached/resets" tokens: "You're out of usage credits. Run
  // /usage-credits to keep using Fable 5 or /model to switch models." Treat it
  // as a usage limit so the run rotates to another account (each has its own
  // credit balance) and, once the pool is drained, falls back off the model.
  if (/out of (usage )?credits/.test(s) || s.includes("/usage-credits")) return true;
  if (/claude (ai )?usage limit reached/.test(s)) return true;
  if (/limit (reached|hit).{0,60}resets/.test(s)) return true;
  // Short result that is just a limit notice, whatever the exact phrasing
  if (s.length < 200 && /\blimit\b/.test(s) && /\bresets\b/.test(s)) return true;
  if (!isErrorResult) return false;
  if (s.includes("rate_limit_error") || s.includes("429") || s.includes("too many requests")) return true;
  return (
    (s.includes("usage") || s.includes("rate") || s.includes("limit")) &&
    (s.includes("exceeded") || s.includes("reached"))
  );
}

export function isCodexUsageLimitError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("429") ||
    s.includes("usage limit") ||
    (s.includes("limit") && s.includes("reached")) ||
    s.includes("too many requests")
  );
}
