/**
 * Shared GitHub rate-limit gate.
 *
 * Every server-side GitHub caller (gh CLI spawns and direct api.github.com
 * fetches) reports rate-limit failures here and consults the gate before
 * firing, so one exhausted quota pauses ALL pollers together instead of each
 * one independently burning doomed calls into the same bot account's window.
 * Callers with cached data keep serving their stale snapshot for the duration;
 * callers without any answer fast with a friendly error instead of spawning gh.
 *
 * State parks on globalThis so a `bun --hot` reload keeps an active backoff
 * window instead of resetting it and re-firing everything at once — and the
 * backoff window is ALSO persisted to disk, because a real `systemctl restart`
 * used to forget it and boot the PR-cache warm sweep straight into the
 * exhausted window (2026-07-23: restarts every ~10min kept the GraphQL quota
 * pinned at 0 for hours).
 */

import { existsSync, readFileSync } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";
import { stateDir } from "./paths";

const PERSIST_PATH = stateDir("github-limit.json");

interface GhLimitState {
  /** Epoch ms until which GitHub calls should not be attempted. 0 = clear. */
  backoffUntil: number;
  probe: Promise<void> | null;
  /** Cached `gh auth token` output for direct REST calls (null = probed, none). */
}

const state: GhLimitState = ((globalThis as any).__osGhLimitState ||= (() => {
  const s: GhLimitState = { backoffUntil: 0, probe: null };
  try {
    if (existsSync(PERSIST_PATH)) {
      const parsed = JSON.parse(readFileSync(PERSIST_PATH, "utf-8"));
      if (typeof parsed?.backoffUntil === "number" && parsed.backoffUntil > Date.now()) {
        s.backoffUntil = parsed.backoffUntil;
        console.error(
          `[github-limit] resuming persisted backoff until ${new Date(s.backoffUntil).toISOString()}`,
        );
      }
    }
  } catch {}
  return s;
})());

function persistBackoff(): void {
  try {
    writeFileAtomic(PERSIST_PATH, JSON.stringify({ backoffUntil: state.backoffUntil }) + "\n");
  } catch {}
}

export function ghRateLimited(): boolean {
  return Date.now() < state.backoffUntil;
}

/** Epoch ms the current backoff ends, or 0 when no backoff is active. */
export function ghBackoffUntil(): number {
  return ghRateLimited() ? state.backoffUntil : 0;
}

/**
 * Test seam (bun tests only): open or clear the backoff window WITHOUT
 * persisting it. Tests that seed a PR-cache snapshot need the gate closed, or
 * a live `gh` refresh lands mid-test and replaces the snapshot with whatever
 * GitHub actually returns — which is also a real network call from a unit
 * test. noteGhRateLimited is the wrong tool for that: it writes the backoff to
 * disk, and `stateDir` resolves against the HOME captured at module load, so a
 * test would pause the running server's GitHub polling for an hour. Returns
 * the previous value so afterAll can restore it.
 */
export function __setGhBackoffForTest(untilEpochMs: number): number {
  const prev = state.backoffUntil;
  state.backoffUntil = untilEpochMs;
  return prev;
}

/** True when a gh CLI / API error message is a rate-limit rejection. */
export function isGhRateLimitMsg(msg: string): boolean {
  return /rate limit|secondary limit|abuse detection/i.test(msg);
}

/**
 * Record that GitHub rejected a call for rate limiting. When the caller knows
 * the reset time (REST's x-ratelimit-reset header), it passes it; otherwise we
 * probe `gh api rate_limit` for the GraphQL reset — rate_limit itself is REST
 * (core quota), so it usually still answers when GraphQL, which nearly all of
 * our polling runs on, is exhausted. A 15-minute fallback covers the probe
 * failing too (core quota can be gone as well).
 */
export function noteGhRateLimited(source: string, resetEpochMs?: number): void {
  if (resetEpochMs && resetEpochMs > Date.now()) {
    // Cap at 2h in case a caller feeds us a bogus far-future reset.
    const until = Math.min(resetEpochMs + 30_000, Date.now() + 2 * 3600_000);
    if (until > state.backoffUntil) {
      state.backoffUntil = until;
      persistBackoff();
      console.error(
        `[github-limit] ${source}: rate-limited; pausing GitHub calls until ${new Date(until).toISOString()}`,
      );
    }
    return;
  }
  if (ghRateLimited() || state.probe) return;
  // Fallback first, in case the probe below fails.
  state.backoffUntil = Date.now() + 15 * 60_000;
  persistBackoff();
  state.probe = (async () => {
    try {
      // Probe with the operator-selected service credential. Invoking ambient
      // `gh` here would cross the App cutover through hosts.yml on failures.
      const { githubToken } = await import("./github-app");
      const token = await githubToken();
      if (token) {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const data = await response.json().catch(() => null) as any;
        const reset = Number(data?.resources?.graphql?.reset) * 1000;
        if (response.ok && reset > Date.now()) {
          state.backoffUntil = reset + 30_000;
          persistBackoff();
        }
      }
    } catch {}
    console.error(
      `[github-limit] ${source}: rate-limited; pausing GitHub calls until ${new Date(state.backoffUntil).toISOString()}`,
    );
    state.probe = null;
  })();
}

/**
 * Token for direct api.github.com calls made on the bot's behalf (conditional
 * change probes and the like): a short-lived App installation token. Missing
 * App authority fails closed; ambient gh accounts are never consulted.
 */
export async function botGhToken(
  opts: { write?: boolean } = {},
): Promise<string | null> {
  const { githubToken } = await import("./github-app");
  return githubToken(opts);
}
