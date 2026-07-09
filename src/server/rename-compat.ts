/**
 * rename-compat — the Backstage → OpenSession rename compatibility layer
 * (docs/rename-opensession-plan.md).
 *
 * New names are primary everywhere; every old name keeps working:
 *
 *  - `envAlias("OPENSESSION_X", "BACKSTAGE_X")`: read the new env var first,
 *    fall back to the old one. Using the old name logs a one-time deprecation
 *    line per key (never per read).
 *  - `statePath(".opensession-x", ".backstage-x")` / `stateDir("x")`: resolve
 *    a state file/dir under $HOME with dual-read — use the new path if it
 *    exists, else the old one if it exists, else the new one (create-new).
 *    Mirrors the proven paths.ts chats-dir precedent. Resolution is cached
 *    per (HOME, name) so a mid-process migration can never split reads and
 *    writes across the two names.
 *
 * The migration script (scripts/migrate-opensession-state.sh) renames
 * `~/.backstage-*` → `~/.opensession-*` during a restart window and leaves
 * symlinks at the old names; with the dual-read here the code works before,
 * during, and after that window. Do NOT dual-write.
 *
 * Out of scope (never renamed — see the plan's Tier C): `bks-`/`prj-` id
 * prefixes, `michael-*` MCP server ids, `===MICHAEL-SUMMARY===` markers,
 * `BACKSTAGE_VIDEO:` transcript markers, the `backstage-rpc.sock` filename.
 */

import { existsSync } from "fs";

// Parked on globalThis so `bun --hot` reloads keep the one-time-warn sets and
// the resolved-path cache (a reload must not re-log or re-resolve mid-flight).
const g = globalThis as unknown as {
	__renameCompatWarned?: Set<string>;
	__renameCompatPaths?: Map<string, string>;
};
const warnedKeys: Set<string> = (g.__renameCompatWarned ??= new Set());
const resolvedPaths: Map<string, string> = (g.__renameCompatPaths ??= new Map());

function deprecateOnce(key: string, message: string): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn(`[rename-compat] ${message}`);
}

/**
 * Read an env var by its new (OPENSESSION_*) name, falling back to the old
 * (BACKSTAGE_* or MICHAEL_*) name. Empty strings count as unset — call sites all
 * use `envAlias(...) || default` semantics, matching the `process.env.X ||`
 * pattern this replaces.
 */
export function envAlias(newKey: string, oldKey: string): string | undefined {
	const v = process.env[newKey];
	if (v) return v;
	const old = process.env[oldKey];
	if (old) {
		deprecateOnce(
			`env:${oldKey}`,
			`env ${oldKey} is deprecated — set ${newKey} instead (the old name still works)`,
		);
		return old;
	}
	return undefined;
}

/**
 * Resolve a $HOME-relative state path with dual-read: prefer `~/<newRel>` if
 * it exists, else `~/<oldRel>` if it exists, else `~/<newRel>` (create-new —
 * callers mkdir/write as they always did). Resolved once per (HOME, newRel)
 * for process-lifetime consistency; the migration script runs in a restart
 * window, so a long-lived process never needs to see the rename happen.
 */
export function statePath(newRel: string, oldRel: string): string {
	const home = process.env.HOME || "/home/ubuntu";
	const cacheKey = `${home}|${newRel}`;
	const cached = resolvedPaths.get(cacheKey);
	if (cached) return cached;
	const newPath = `${home}/${newRel}`;
	const oldPath = `${home}/${oldRel}`;
	const chosen =
		existsSync(newPath) || !existsSync(oldPath) ? newPath : oldPath;
	resolvedPaths.set(cacheKey, chosen);
	return chosen;
}

/**
 * Sugar for the standard state-dir naming: `stateDir("audit")` resolves
 * `~/.opensession-audit` (new) with `~/.backstage-audit` fallback. Works for
 * files too (e.g. `stateDir("pins.json")` → `~/.opensession-pins.json`).
 */
export function stateDir(base: string): string {
	return statePath(`.opensession-${base}`, `.backstage-${base}`);
}

/** Test hook: forget cached resolutions + one-time warns (suites point HOME
 *  at scratch dirs and create/remove state between cases). */
export function __resetRenameCompatForTest(): void {
	resolvedPaths.clear();
	warnedKeys.clear();
}
