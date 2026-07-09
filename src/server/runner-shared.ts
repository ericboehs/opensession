/**
 * Engine-neutral runner infrastructure shared across engines and agents:
 *
 * - filterMcpServers: per-run MCP resolution (allowlist + per-user
 *   `allowedUsers` gating, strips our metadata before the config reaches an
 *   engine).
 * - STRIPE_CONFIRM_TOOLS: the money-moving Stripe tool catalog (confirm-listed
 *   in interactive runs, denied/stripped in unattended ones).
 * - isClaudeUsageLimitError / isCodexUsageLimitError: provider usage-limit
 *   detection driving account rotation and model fallback.
 * - CLAUDE_CODE_BIN: the Claude Code CLI path (the Meridian bridge's motor).
 *
 * Implementations still live in claude-runner.ts / codex-runner.ts until the
 * legacy engines are deleted; import from here so no surviving file depends on
 * a doomed one.
 */
export {
  filterMcpServers,
  STRIPE_CONFIRM_TOOLS,
  isClaudeUsageLimitError,
  CLAUDE_CODE_BIN,
} from "./claude-runner";
export { isCodexUsageLimitError } from "./codex-runner";
