/**
 * One-time (per page load) local-pref migration for the michael-* →
 * opensession-* identifier rename: any legacy-prefixed localStorage value is
 * copied to its opensession-* key when the new key is absent. Legacy values
 * are deliberately NOT deleted — a stale tab still running an old bundle
 * keeps working — new code simply reads/writes only the new keys.
 *
 * Imported FIRST in App.tsx (it has no dependencies), so it runs before any
 * lib module reads its key at module-load time.
 */
const LEGACY_PREFIX = "michael-";
const NEW_PREFIX = "opensession-";

try {
  const legacyKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_PREFIX)) legacyKeys.push(k);
  }
  for (const k of legacyKeys) {
    const nk = NEW_PREFIX + k.slice(LEGACY_PREFIX.length);
    const v = localStorage.getItem(k);
    if (v !== null && localStorage.getItem(nk) === null) {
      localStorage.setItem(nk, v);
    }
  }
} catch {
  // Storage unavailable (private mode edge cases) — prefs fall to defaults.
}
