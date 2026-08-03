/**
 * Shared on-disk paths for the chat store, with a dual-read fallback chain.
 *
 * Naming history: `~/.backstage-sessions` → `~/.backstage-chats` (see
 * scripts/migrate-workspaces.ts) → `~/.opensession-chats` (the product rename,
 * docs/rename-opensession-plan.md + scripts/migrate-opensession-state.sh).
 * This resolves the active dir once at load: prefer the newest name that
 * exists, fall back through the older ones until the migrations rename them.
 * Resolving once keeps every module (and reads/writes) on the same dir
 * whether or not a migration has run. The `bks-` id prefix stays opaque.
 *
 * Run migrations during a restart window (they rename dirs on disk); a
 * long-running process resolves this constant at boot and won't see a
 * mid-flight rename.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { envAlias, stateDir } from "./rename-compat";
import { isLocalProfile, localProfileRoot } from "./profile";

/** The current user's home directory ($HOME wins so tests can repoint it). */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

const HOME = homeDir();
const CHATS_LEGACY = `${HOME}/.backstage-sessions`;

function resolveChatsDir(): string {
  // Env override first (test/verify/conformance suites point it at a scratch
  // dir so sbxtest state files, run dirs and kill-switch checks never touch
  // the live store — set it BEFORE importing any src/server module).
  const fromEnv = envAlias("OPENSESSION_CHATS_DIR", "BACKSTAGE_CHATS_DIR");
  if (fromEnv) return fromEnv;
  if (isLocalProfile()) return `${localProfileRoot()}/sessions`;
  // `~/.opensession-chats` → `~/.backstage-chats` dual-read, then the
  // pre-workspaces legacy name, then create-new at the primary name.
  const resolved = stateDir("chats");
  if (existsSync(resolved) || !existsSync(CHATS_LEGACY)) return resolved;
  return CHATS_LEGACY;
}

/** The active chat-store dir. */
export let OPENSESSION_CHATS_DIR = resolveChatsDir();

/** Deprecated alias (same live binding) — new code imports OPENSESSION_CHATS_DIR. */
export { OPENSESSION_CHATS_DIR as BACKSTAGE_CHATS_DIR };

/**
 * Test seam (bun tests only): repoint the chat store AFTER this module has
 * been evaluated. ES module bindings are live, so consumers that read
 * `OPENSESSION_CHATS_DIR` at THEIR load time (e.g. sessions.ts, which the tests
 * re-import cache-busted) pick the new value up — the env override above only
 * works when it's set before the first import of this module, which a bun
 * test file can't guarantee (file execution order is not alphabetical, and
 * any earlier test file importing the server graph evaluates this module).
 * Returns the previous value so afterAll can restore it.
 */
export function __setChatsDirForTest(dir: string): string {
  const prev = OPENSESSION_CHATS_DIR;
  OPENSESSION_CHATS_DIR = dir;
  return prev;
}
