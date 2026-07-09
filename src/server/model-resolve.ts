/**
 * Native-model resolution for the DIRECT-SDK dispatch paths.
 *
 * A few agent loops (Slack/Linear/Plain `processMessage`-style code) call the
 * Claude Agent SDK `query()` / the Codex SDK `runCodexAuto()` DIRECTLY — they do
 * not route through `runAgent`/`runOnModel`, so nothing peels an OpenCode engine
 * prefix off the model id for them. When the fleet default is flipped to an
 * OpenCode id (e.g. `opencode/anthropic/claude-sonnet-5` during the opencode
 * migration), that raw string reaches the Claude/Codex CLI, which rejects it
 * ("There's an issue with the selected model … It may not exist.").
 *
 * These direct paths are NOT migrating to the opencode runner in this fix (that's
 * a bigger change) — they just must not choke on an opencode-namespaced default.
 * `resolveDirectSdkModel` maps an OpenCode id down to the underlying native id the
 * SDK understands, and passes a bare/native id through unchanged:
 *
 *   opencode/anthropic/claude-sonnet-5  → claude-sonnet-5   (native Claude id)
 *   opencode/openai/gpt-5.5             → gpt-5.5            (native Codex/GPT id)
 *   opencode/anthropic/claude-opus-4-8  → claude-opus-4-8
 *   claude-sonnet-5 / gpt-5.5 / …       → unchanged (native passthrough)
 *
 * Because native ids pass straight through, the native Claude/Codex model ids
 * (claude-sonnet-5, gpt-5.5, …) MUST remain valid SDK model strings even if they
 * are dropped from the picker/KNOWN_MODELS registry — see the cross-agent note.
 *
 * Kept as a standalone, dependency-free module (no import from the in-flux
 * models.ts) so it composes with `providerFor()` without coupling: callers that
 * need the provider of the *effective* SDK model use
 * `providerFor(resolveDirectSdkModel(id))`.
 */
export function resolveDirectSdkModel(id: string | null | undefined): string {
  const s = (id || "").trim();
  if (!s) return s;
  // opencode/<engineProvider>/<native-model…> — the native id is the tail after
  // the engine + provider segments. `pop()` yields the model slug the SDK runs.
  if (s.startsWith("opencode/") && s.slice("opencode/".length).includes("/")) {
    const tail = s.split("/").pop();
    if (tail) return tail;
  }
  return s;
}
