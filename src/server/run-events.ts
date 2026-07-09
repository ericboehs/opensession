/**
 * Engine-neutral run event types shared by every runner (opencode, and the
 * legacy claude/codex runners while they last) and by everything that consumes
 * a run's event stream (opensession.ts, sandbox providers, the runner host).
 *
 * Canonical home for these types. The implementations still live in
 * claude-runner.ts until the legacy engines are deleted; this module is the
 * import surface so no surviving file depends on a doomed one.
 */
export type { StreamEvent, TurnUsage, ImageInput } from "./claude-runner";
