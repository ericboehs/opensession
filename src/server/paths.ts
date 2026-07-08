/**
 * Shared on-disk paths for the chat store, with a dual-read fallback.
 *
 * The store dir was renamed `~/.backstage-sessions` → `~/.backstage-chats` (see
 * scripts/migrate-workspaces.ts). This resolves the active dir once at load:
 * prefer the new name, fall back to the legacy name until the migration renames
 * it. Resolving once keeps every module (and reads/writes) on the same dir
 * whether or not the migration has run. The `bks-` id prefix stays opaque.
 *
 * Run the migration during a restart window (it renames the dir on disk); a
 * long-running process resolves this constant at boot and won't see a mid-flight
 * rename.
 */

import { existsSync } from "fs";

const HOME = process.env.HOME || "/home/ubuntu";
const CHATS_NEW = `${HOME}/.backstage-chats`;
const CHATS_LEGACY = `${HOME}/.backstage-sessions`;

/** The active chat-store dir: env override first (test/verify/conformance
 *  suites point it at a scratch dir so sbxtest state files, run dirs and
 *  kill-switch checks never touch the live store — set it BEFORE importing
 *  any src/server module), else the new name if present, else legacy. */
export let BACKSTAGE_CHATS_DIR =
  process.env.BACKSTAGE_CHATS_DIR ||
  (existsSync(CHATS_NEW) || !existsSync(CHATS_LEGACY) ? CHATS_NEW : CHATS_LEGACY);

/**
 * Test seam (bun tests only): repoint the chat store AFTER this module has
 * been evaluated. ES module bindings are live, so consumers that read
 * `BACKSTAGE_CHATS_DIR` at THEIR load time (e.g. sessions.ts, which the tests
 * re-import cache-busted) pick the new value up — the env override above only
 * works when it's set before the first import of this module, which a bun
 * test file can't guarantee (file execution order is not alphabetical, and
 * any earlier test file importing the server graph evaluates this module).
 * Returns the previous value so afterAll can restore it.
 */
export function __setChatsDirForTest(dir: string): string {
  const prev = BACKSTAGE_CHATS_DIR;
  BACKSTAGE_CHATS_DIR = dir;
  return prev;
}
